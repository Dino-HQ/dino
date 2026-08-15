/**
 * @dino/cli — Shared types and helpers for all commands.
 * Spec: docs/CLI_SPEC.md §2–4
 */

import {
  createTracker,
  createNoopAdapter,
  createPostHogAdapter,
  sanitizeEventError,
  sanitizeCliFlags,
} from '@dino/analytics';
import { loadTenantById, recordGet } from '@dino/core';
import { createDiscoveryBridge, logger as engineLogger } from '@dino/engine';
import { buildAuthHeaders } from './auth-headers';
import { CliError } from './errors';
import { readIntrospectionLevel } from './introspection-level';
import { oauth2DescriptorFromConfig, resolveAuthHeaders } from './oauth2-auth';
import { boundErrorMessage } from './outcome';
import { reportCaughtFailure } from './report-failure';
import { requireStringFlag } from './require-string-flag';
import { getEffectiveTelemetryLevel, readGlobalDinoConfigSync } from '../config/global-dino-config';
import { CLI_VERSION } from '../version';
import type { OAuth2AuthDescriptor } from './oauth2-auth';
import type { DinoCliConfig } from '../config/loader';
import type { AnalyticsAdapter, Tracker } from '@dino/analytics';
import type { TenantConfig, ApiConfig, GraphQLOperation, Operation } from '@dino/core';

export { buildAuthHeaders, parseHeaderArg } from './auth-headers';
export { parseArgs } from './parse-args';
export { resolveAuthHeaders } from './oauth2-auth';
export type { OAuth2AuthDescriptor } from './oauth2-auth';

/** Events sent at 'crash' level (errors/failures only). */
const CRASH_LEVEL_EVENTS = new Set([
  'cli.command.failed',
  'pipeline.tool.failed',
  'pipeline.run.failed',
]);

function createCliAnalyticsAdapter(): AnalyticsAdapter {
  const g = readGlobalDinoConfigSync();
  const level = getEffectiveTelemetryLevel(g);
  if (level === 'off') return createNoopAdapter();
  const key =
    typeof process.env.POSTHOG_API_KEY === 'string' ? process.env.POSTHOG_API_KEY.trim() : '';
  if (!key) return createNoopAdapter();
  const distinctId =
    typeof g.anonymousId === 'string' && g.anonymousId.length > 0 ? g.anonymousId : '';
  if (!distinctId) return createNoopAdapter();
  const inner = createPostHogAdapter({ apiKey: key, distinctId });

  // 'all' sends everything; 'crash' filters to error events only
  if (level === 'all') {
    return inner;
  }
  return {
    name: `${inner.name}[crash]`,
    track(event) {
      if (CRASH_LEVEL_EVENTS.has(event.type)) {
        inner.track(event);
      }
    },
    shutdown: inner.shutdown?.bind(inner),
  };
}

/** Parsed CLI flags common to all commands.
 * Index signature: flags come from CLI arg parsing and may include arbitrary keys
 * from loaded config or command-specific extensions. */
export interface CommonFlags {
  [key: string]: unknown;
  tenant: string;
  env?: string | undefined;
  format?: ('markdown' | 'json') | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  debug?: boolean | undefined;
  noColor?: boolean | undefined;
  endpoint?: string | undefined; // #171: ad-hoc scan via CLI flag
  protocol?: ('graphql' | 'rest') | undefined;
  specUrl?: string | undefined;
  /** #2160: static auth header(s), repeatable (`"Name: Value"`) */
  header?: string | string[] | undefined;
  /** #2160: shortcut for Authorization: Bearer <token> */
  token?: string | undefined;
}

/** Parsed + merged flags at command dispatch (config + argv + common). */
export type MergedFlags = CommonFlags & Record<string, unknown>;

/** Context assembled before command execution */
export interface CommandContext {
  tenantConfig: TenantConfig;
  tenantId: string;
  environment: string;
  tracker: Tracker;
  /** #2160: static auth headers for discovery + scan (undefined when no auth configured) */
  authHeaders?: Record<string, string> | undefined;
  /** #2161: oauth2 flat-config descriptor; resolved asynchronously via resolveAuthHeaders */
  oauth2Auth?: OAuth2AuthDescriptor | undefined;
  /** Test seam: override fetch for OAuth2 token acquisition (#2161) */
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Resolve the API endpoint from tenant config.
 * Shared by scan, docs, and diff commands.
 */
export function getEndpoint(context: CommandContext): string {
  if (!context.tenantConfig.environments) {
    throw new CliError(
      'Tenant has no environments configuration',
      1,
      'Check your tenant YAML has an environments: section.',
    );
  }
  const envConfig = recordGet(context.tenantConfig.environments, context.environment);
  if (!envConfig) {
    throw new CliError(
      `Environment "${context.environment}" not found. Available: ${Object.keys(context.tenantConfig.environments).join(', ')}`,
      1,
      'Run dino validate to check your config.',
    );
  }
  const apiName = context.tenantConfig.apis[0]?.name;
  if (!apiName) throw new CliError('Tenant has no apis[].name');
  if (!envConfig.endpoints) {
    throw new CliError(`API endpoints not configured for environment "${context.environment}"`);
  }
  const endpoint = recordGet(envConfig.endpoints, apiName);
  if (!endpoint) {
    throw new CliError(
      `API "${apiName}" not found in environment "${context.environment}". Keys: ${Object.keys(envConfig.endpoints).join(', ')}`,
    );
  }
  return endpoint;
}

/** Full discovery slice for scan (GraphQL catalog + REST pipeline wiring, Spec 8). */
export interface DiscoverOperationsResult {
  graphqlOperations: GraphQLOperation[];
  discoveredOperations: Operation[];
  discoveryRaw: unknown;
  /** #202: discovery fidelity for durable report disclosure */
  introspectionLevel?: 'full' | 'shallow' | 'minimal' | undefined;
}

async function runPluginDiscovery(context: CommandContext) {
  const endpoint = getEndpoint(context);
  const envConfig = recordGet(context.tenantConfig.environments, context.environment);
  if (!envConfig) {
    throw new Error(`Environment '${context.environment}' not found in tenant config`);
  }
  const plugin = createDiscoveryBridge({
    tenant: context.tenantConfig,
    environment: context.environment,
  });

  // REST APIs need specPath from tenant config for OpenAPI discovery
  const api = context.tenantConfig.apis[0];
  const specPath = api && 'specPath' in api ? (api as { specPath?: string }).specPath : undefined;

  // #2161: async oauth2 acquisition at the discovery boundary (buildContext stays sync)
  const authHeaders = await resolveAuthHeaders(context);

  try {
    return await plugin.discover({
      endpoint,
      specPath,
      timeout: envConfig.timeout,
      ...(authHeaders ? { headers: authHeaders } : {}),
      logger: {
        info: (m: string) => engineLogger.info(m),
        warn: (m: string) => engineLogger.warn(m),
      },
    });
  } catch (err: unknown) {
    if (isIntrospectionTimeout(err)) {
      throw buildIntrospectionTimeoutError(endpoint, envConfig.timeout, err);
    }
    throw err;
  }
}

/**
 * Discovery with GraphQL operations (for catalog) plus universal `Operation[]` (REST/OpenAPI).
 * @internal Exported for `dino scan` REST wiring; other commands use {@link discoverOperations}.
 */
export async function discoverOperationsDetailed(
  context: CommandContext,
): Promise<DiscoverOperationsResult> {
  const discoveryResult = await runPluginDiscovery(context);

  if (!discoveryResult.operations || discoveryResult.operations.length === 0) {
    throw new CliError(
      'Discovery returned no operations',
      1,
      'Confirm the endpoint supports GraphQL introspection or a valid OpenAPI spec for REST.',
    );
  }

  const raw = discoveryResult.raw;
  const rawOps = (() => {
    if (!raw || typeof raw !== 'object') return undefined;
    const candidate = (raw as { operations?: unknown }).operations;
    return Array.isArray(candidate) ? (candidate as GraphQLOperation[]) : undefined;
  })();

  const graphqlOperations =
    rawOps && rawOps.length > 0 && typeof rawOps[0]?.name === 'string' && 'args' in rawOps[0]
      ? rawOps
      : [];

  return {
    graphqlOperations,
    discoveredOperations: discoveryResult.operations,
    discoveryRaw: raw,
    introspectionLevel: readIntrospectionLevel(raw),
  };
}

/**
 * Run introspection discovery and return validated GraphQL operations.
 * Shared by scan, docs, and diff commands.
 * For REST-only tenants returns an empty array (catalog has no GraphQL operations).
 */
export async function discoverOperations(context: CommandContext): Promise<GraphQLOperation[]> {
  const d = await discoverOperationsDetailed(context);
  return d.graphqlOperations;
}

/** Detect the AbortController timeout signature from plugin.discover. INV-UX-1. */
function isIntrospectionTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // AbortError or timeout message; unparenthesized || is intentional (Prettier / Maciver LOW).
  return err.name === 'AbortError' || err.message.includes('aborted due to timeout');
}

/** Build the actionable CliError for a timeout. INV-UX-2, INV-UX-3. */
function buildIntrospectionTimeoutError(
  endpoint: string,
  timeoutMs: number,
  cause: unknown,
): CliError {
  const message = `Introspection timed out after ${timeoutMs}ms.\nEndpoint: ${endpoint}`;
  const hint = [
    'Common causes:',
    '  • Endpoint does not support GraphQL introspection at this path',
    `  • Path suffix missing - try ${endpoint.replace(/\/?$/, '/graphql')}`,
    '  • Authentication required but not configured (run: dino init)',
    '  • Endpoint unreachable from this network',
  ].join('\n');
  return new CliError(message, 1, hint, cause);
}

/** Options for withTracking. */
export interface WithTrackingOptions {
  context: CommandContext;
  command: string;
  flagsPayload: Record<string, unknown>;
  quiet: boolean | undefined;
  body: () => Promise<number>;
}

/**
 * Wrap a command body with analytics tracking (invoked/completed/failed).
 * Returns the body's exit code on success; thrown errors resolve via reportCaughtFailure.
 */
export async function withTracking(opts: WithTrackingOptions): Promise<number> {
  // `quiet` is accepted on the options for API symmetry but no longer gates error output
  // (#2143: errors always surface on stderr regardless of --quiet).
  const { context, command, flagsPayload, body } = opts;
  const startMs = Date.now(); // determinism:allowed
  context.tracker.track({
    type: 'cli.command.invoked',
    timestamp: new Date().toISOString(), // determinism:allowed
    tenantId: context.tenantId,
    properties: { command, flags: sanitizeCliFlags(flagsPayload), version: CLI_VERSION },
  });

  try {
    const exitCode = await body();
    const durationMs = Date.now() - startMs; // determinism:allowed
    context.tracker.track({
      type: 'cli.command.completed',
      timestamp: new Date().toISOString(), // determinism:allowed
      tenantId: context.tenantId,
      properties: { command, durationMs, exitCode },
    });
    return exitCode;
  } catch (err) {
    const durationMs = Date.now() - startMs; // determinism:allowed
    context.tracker.track({
      type: 'cli.command.failed',
      timestamp: new Date().toISOString(), // determinism:allowed
      tenantId: context.tenantId,
      properties: {
        command,
        durationMs,
        error: sanitizeEventError(boundErrorMessage(err)),
        errorClass: err instanceof Error ? err.name : 'Unknown',
      },
    });
    return reportCaughtFailure(err, flagsPayload);
  }
}

/**
 * Build a synthetic TenantConfig for ad-hoc scans (no tenant YAML).
 * Endpoint comes from .dino.yml directly. All agents disabled (scan uses tools, not agents).
 * Request timeout uses the default from #560.
 *
 * #2140: `protocol: 'rest'` discovers operations from an OpenAPI spec (`specPath`,
 * a URL or file path) rather than GraphQL introspection. REST has no introspection,
 * so the spec is mandatory — a missing spec is a config error, not a silent empty scan.
 */
function buildAdHocTenantConfig(
  endpoint: string,
  protocol: 'graphql' | 'rest',
  requestTimeoutMs: number,
  specPath?: string,
): TenantConfig {
  let api: ApiConfig;
  if (protocol === 'rest') {
    if (specPath === undefined || specPath.trim() === '') {
      throw new CliError(
        'protocol: rest requires specUrl (a URL or file path to your OpenAPI spec).',
        2,
        'Add specUrl: <openapi-url-or-path> to your .dino.yml, or use protocol: graphql.',
        undefined,
        'usage',
      );
    }
    api = { name: 'default', type: 'rest', source: 'openapi', specPath };
  } else {
    api = { name: 'default', type: 'graphql', source: 'introspection' };
  }
  return {
    schemaVersion: 1,
    id: 'adhoc',
    name: 'Ad-hoc scan',
    apis: [api],
    environments: {
      default: {
        endpoints: { default: endpoint },
        timeout: requestTimeoutMs,
        retries: 0,
      },
    },
    defaultEnvironment: 'default',
    auth: { adapter: 'none', adapterConfig: {}, roles: [] },
    agents: [],
  };
}

function withOptionalAuth(
  base: Omit<CommandContext, 'authHeaders' | 'oauth2Auth' | 'fetchImpl'>,
  authHeaders: Record<string, string> | undefined,
  oauth2Auth: OAuth2AuthDescriptor | undefined,
): CommandContext {
  return {
    ...base,
    ...(authHeaders ? { authHeaders } : {}),
    ...(oauth2Auth ? { oauth2Auth } : {}),
  };
}

/**
 * Build CommandContext from flags + optional config. Flags take precedence over config.
 */
export function buildContext(flags: CommonFlags, config: DinoCliConfig | null): CommandContext {
  const tenantId = flags.tenant ?? config?.tenant ?? '';

  // Value-less `--endpoint`/`--protocol`/`--spec-url` arrive as boolean `true` from parseFlag —
  // reject at the consumption point (do not change parseFlag; booleans are valid for --quiet etc.)
  const endpointFlag = requireStringFlag('--endpoint', flags.endpoint, {
    requires: 'a URL value (e.g. --endpoint https://api.example.com/graphql).',
    hint: 'Pass the endpoint URL immediately after the flag.',
  });
  const protocolFlag = requireStringFlag('--protocol', flags.protocol, {
    requires: 'a value: graphql or rest',
    hint: 'Pass graphql or rest immediately after the flag.',
  });
  const specUrlFlag = requireStringFlag('--spec-url', flags.specUrl, {
    requires: 'a URL or file path value.',
    hint: 'Pass the spec URL or path immediately after the flag.',
  });

  const authHeaders = buildAuthHeaders(flags, config);
  const oauth2Auth = oauth2DescriptorFromConfig(config);

  // #560/#171: Ad-hoc mode — endpoint from flags (preferred) or .dino.yml; no tenant needed
  const adhocEndpoint = endpointFlag ?? config?.endpoint;
  if (!tenantId && typeof adhocEndpoint === 'string' && adhocEndpoint.length > 0) {
    const protocolRaw = protocolFlag ?? config?.protocol ?? 'graphql';
    const protocol: 'graphql' | 'rest' = protocolRaw === 'rest' ? 'rest' : 'graphql';
    return withOptionalAuth(
      {
        tenantConfig: buildAdHocTenantConfig(
          adhocEndpoint,
          protocol,
          30_000,
          specUrlFlag ?? config?.specUrl,
        ),
        tenantId: 'adhoc',
        environment: 'default',
        tracker: createTracker({ adapter: createCliAnalyticsAdapter(), tenantId: 'adhoc' }),
      },
      authHeaders,
      oauth2Auth,
    );
  }

  if (!tenantId) {
    throw new CliError(
      'tenant is required (--tenant <id> or set in .dino.yml). ' +
        'Or provide endpoint + protocol for an ad-hoc scan.',
      2,
      'Run dino init to create a .dino.yml config.',
      undefined,
      'usage',
    );
  }
  const tenantConfig = loadTenantById(tenantId);
  return withOptionalAuth(
    {
      tenantConfig,
      tenantId,
      environment: flags.env ?? config?.environment ?? tenantConfig.defaultEnvironment,
      tracker: createTracker({ adapter: createCliAnalyticsAdapter(), tenantId }),
    },
    authHeaders,
    oauth2Auth,
  );
}
