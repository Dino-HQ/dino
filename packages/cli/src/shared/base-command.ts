/**
 * @dino/cli — Shared types and helpers for all commands.
 * Spec: docs/CLI_SPEC.md §2–4
 */

import os from 'node:os';
import ci from 'ci-info';
import {
  createTracker,
  createNoopAdapter,
  createPostHogAdapter,
  createConsoleAdapter,
  sanitizeEventError,
  sanitizeCliFlags,
} from '@dino/analytics';
import { loadTenantById, recordGet, type ApiConfig, type GraphQLOperation, type Operation, type TenantConfig, type VerificationTarget } from '@dino/core';
import { resolveSelectedTarget } from './selected-target';
import { logger as engineLogger } from '@dino/engine';
import { buildAuthHeaders } from './auth-headers';
import {
  CliError,
  buildIntrospectionTimeoutError,
  isIntrospectionTimeout,
  isOpenApiSpecLoadError,
  toGraphqlIntrospectionCliError,
  toOpenApiSpecLoadCliError,
  throwTenantConfigCliError,
} from './errors';
import { readDiscoveryProvenance } from './introspection-level';
import { oauth2DescriptorFromConfig, resolveAuthHeaders } from './oauth2-auth';
import { boundErrorMessage, isUpstreamClientError } from './outcome';
import { reportCaughtFailure } from './report-failure';
import { requireTargetFlagValues } from './require-string-flag';
import { createTenantDiscoveryBridge } from './tenant-discovery-bridge';
import {
  getEffectiveTelemetryLevel,
  readGlobalDinoConfigSync,
  ensureAnonymousId,
} from '../config/global-dino-config';
import { CLI_VERSION } from '../version';
import type { OAuth2AuthDescriptor } from './oauth2-auth';
import type { DinoCliConfig } from '../config/loader';
import type { AnalyticsAdapter, Tracker } from '@dino/analytics';

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

export interface MachineInfo {
  os: NodeJS.Platform;
  arch: string;
  cpuCount: number;
  nodeVersion: string;
  isCI: boolean;
  ciName: string | null;
}

export interface MachineInfoDeps {
  os?: Pick<typeof os, 'platform' | 'arch' | 'cpus'>;
  ci?: Pick<typeof ci, 'isCI' | 'name'>;
}

export function collectMachineInfo(deps?: MachineInfoDeps): MachineInfo {
  const osDeps = deps?.os ?? os;
  const ciDeps = deps?.ci ?? ci;
  return {
    os: osDeps.platform(),
    arch: osDeps.arch(),
    cpuCount: osDeps.cpus().length,
    nodeVersion: process.version,
    isCI: ciDeps.isCI,
    ciName: ciDeps.name ?? null,
  };
}

function createCliAnalyticsAdapter(): AnalyticsAdapter {
  const g = readGlobalDinoConfigSync();
  const level = getEffectiveTelemetryLevel(g);
  if (level === 'off') return createNoopAdapter();
  let distinctId: string | null;
  try {
    distinctId = ensureAnonymousId();
  } catch {
    distinctId = null;
  }
  if (!distinctId) return createNoopAdapter();
  if (process.env.DINO_TELEMETRY_DEBUG === '1') {
    return createConsoleAdapter();
  }
  const key =
    typeof process.env.POSTHOG_API_KEY === 'string' ? process.env.POSTHOG_API_KEY.trim() : '';
  if (!key) return createNoopAdapter();
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
  /**
   * Permit a loopback / RFC1918 target. Command line ONLY — never read from `.dino.yml` or a
   * tenant file, because in CI that config is attacker-controllable through a pull request while
   * a typed flag is the operator's own decision.
   */
  allowPrivateTarget?: boolean | undefined;
  /** #2160: shortcut for Authorization: Bearer <token> */
  token?: string | undefined;
}

/** Parsed + merged flags at command dispatch (config + argv + common). */
export type MergedFlags = CommonFlags & Record<string, unknown>;

/** Context assembled before command execution */
export interface CommandContext {
  selectedTarget: VerificationTarget | undefined;
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
  /**
   * The operator's private-target opt-in, carried beside the target it admitted, so a command
   * cannot admit a loopback endpoint at selection and then build an executor that refuses it.
   *
   * Required: this is where the chain begins, and an optional field here is one more hop that can
   * be dropped in silence.
   */
  allowPrivateTarget: boolean;
}

/** Project the already-selected target URL. Shared by scan, docs, and diff commands. */
export function getEndpoint(context: CommandContext): string {
  if (context.selectedTarget === undefined) {
    throwTenantConfigCliError('No verification target selected', 'config');
  }
  return context.selectedTarget.url;
}

/**
 * True when getEndpoint would succeed; null when getEndpoint would throw CliError (#2268).
 * Single-sourced against getEndpoint's five unresolvable states - never a parallel predicate.
 * Non-CliError failures are rethrown (do not mask real bugs as "needs endpoint").
 */
export function resolveEndpointOrNull(context: CommandContext): string | null {
  try {
    return getEndpoint(context);
  } catch (e) {
    if (e instanceof CliError) return null;
    throw e;
  }
}

/** Full discovery slice for scan (GraphQL catalog + REST pipeline wiring, Spec 8). */
export interface DiscoverOperationsResult {
  graphqlOperations: GraphQLOperation[];
  discoveredOperations: Operation[];
  discoveryRaw: unknown;
  introspectionLevel?: 'full' | 'shallow' | 'minimal' | undefined;
  structureSource?: 'live' | 'sdl' | undefined;
}

async function runPluginDiscovery(context: CommandContext) {
  const endpoint = getEndpoint(context);
  const envConfig = recordGet(context.tenantConfig.environments, context.environment);
  if (!envConfig) throw new Error('Invariant: environment missing after getEndpoint');
  const plugin = createTenantDiscoveryBridge(
    context.tenantConfig,
    context.environment,
    context.allowPrivateTarget,
    context.selectedTarget,
  );

  const api = context.tenantConfig.apis[0];
  const specPath = api && 'specPath' in api ? (api as { specPath?: string }).specPath : undefined;

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
    if (isUpstreamClientError(err)) {
      throw toGraphqlIntrospectionCliError(err, endpoint);
    }
    throw err;
  }
}

export async function discoverOperationsDetailed(
  context: CommandContext,
): Promise<DiscoverOperationsResult> {
  let discoveryResult;
  try {
    discoveryResult = await runPluginDiscovery(context);
  } catch (err: unknown) {
    if (isOpenApiSpecLoadError(err)) {
      throw toOpenApiSpecLoadCliError(err);
    }
    throw err;
  }

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
    ...readDiscoveryProvenance(raw),
  };
}

export async function discoverOperations(context: CommandContext): Promise<GraphQLOperation[]> {
  const d = await discoverOperationsDetailed(context);
  return d.graphqlOperations;
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
  target: VerificationTarget,
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
        endpoints: { default: target },
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

function createPipelineTracker(tenantId: string): Tracker {
  return createTracker({
    adapter: createCliAnalyticsAdapter(),
    tenantId,
    staticProperties: { ...collectMachineInfo() },
  });
}

/**
 * Build CommandContext from flags + optional config. Flags take precedence over config.
 */
function selectTenantTarget(tenantConfig: TenantConfig, flags: CommonFlags, config: DinoCliConfig | null, endpointFlag: string | undefined) {
  const environment = flags.env ?? config?.environment ?? tenantConfig.defaultEnvironment;
  const apiName = tenantConfig.apis[0]?.name;
  const envConfig = recordGet(tenantConfig.environments, environment);
  const selectedTarget = resolveSelectedTarget({
    configured: apiName === undefined || envConfig === undefined ? undefined : recordGet(envConfig.endpoints, apiName),
    flatEndpoint: config?.endpoint,
    cliEndpoint: endpointFlag,
    allowPrivateTarget: flags.allowPrivateTarget === true,
  });
  return { environment, selectedTarget };
}

export function buildContext(flags: CommonFlags, config: DinoCliConfig | null): CommandContext {
  const tenantId = flags.tenant ?? config?.tenant ?? '';

  const { endpointFlag, protocolFlag, specUrlFlag } = requireTargetFlagValues(flags);

  const authHeaders = buildAuthHeaders(flags, config);
  const oauth2Auth = oauth2DescriptorFromConfig(config);

  // #560/#171: Ad-hoc mode — endpoint from flags (preferred) or .dino.yml; no tenant needed
  const stringTarget = resolveSelectedTarget({
    flatEndpoint: config?.endpoint,
    cliEndpoint: endpointFlag,
    allowPrivateTarget: flags.allowPrivateTarget === true,
  });
  if (!tenantId && stringTarget !== undefined) {
    const protocolRaw = protocolFlag ?? config?.protocol ?? 'graphql';
    const protocol: 'graphql' | 'rest' = protocolRaw === 'rest' ? 'rest' : 'graphql';
    return withOptionalAuth(
      {
        tenantConfig: buildAdHocTenantConfig(stringTarget, protocol, 30_000, specUrlFlag ?? config?.specUrl),
        tenantId: 'adhoc',
        selectedTarget: stringTarget,
        environment: 'default',
        tracker: createPipelineTracker('adhoc'),
        allowPrivateTarget: flags.allowPrivateTarget === true,
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
  const { environment, selectedTarget } = selectTenantTarget(tenantConfig, flags, config, endpointFlag);
  return withOptionalAuth(
    {
      tenantConfig,
      tenantId,
      environment,
      selectedTarget,
      tracker: createPipelineTracker(tenantId),
      allowPrivateTarget: flags.allowPrivateTarget === true,
    },
    authHeaders,
    oauth2Auth,
  );
}
