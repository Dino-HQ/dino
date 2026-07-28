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
import { loadTenantById, recordGet, recordSet } from '@dino/core';
import { createDiscoveryBridge } from '@dino/engine';
import { CliError } from './errors';
import { printError, detectUi } from './ui';
import { getEffectiveTelemetryLevel, readGlobalDinoConfigSync } from '../config/global-dino-config';
import { CLI_VERSION } from '../version';
import type { DinoCliConfig } from '../config/loader';
import type { AnalyticsAdapter, Tracker } from '@dino/analytics';
import type { TenantConfig, GraphQLOperation, Operation } from '@dino/core';

/** Events sent at 'crash' level (errors/failures only). */
const CRASH_LEVEL_EVENTS = new Set([
  'cli.command.failed',
  'pipeline.tool.failed',
  'pipeline.run.failed',
]);

function createCliAnalyticsAdapter(): AnalyticsAdapter {
  const g = readGlobalDinoConfigSync();
  const level = getEffectiveTelemetryLevel(g);
  if (level === 'off') {
    return createNoopAdapter();
  }
  const key =
    typeof process.env.POSTHOG_API_KEY === 'string' ? process.env.POSTHOG_API_KEY.trim() : '';
  if (!key) {
    return createNoopAdapter();
  }
  const distinctId =
    typeof g.anonymousId === 'string' && g.anonymousId.length > 0 ? g.anonymousId : '';
  if (!distinctId) {
    return createNoopAdapter();
  }
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
}

/** Parsed + merged flags at command dispatch (config + argv + common). */
export type MergedFlags = CommonFlags & Record<string, unknown>;

/** Context assembled before command execution */
export interface CommandContext {
  tenantConfig: TenantConfig;
  tenantId: string;
  environment: string;
  tracker: Tracker;
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

  try {
    return await plugin.discover({
      endpoint,
      specPath,
      timeout: envConfig.timeout,
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
  // Node's AbortController rejects with DOMException name 'AbortError' OR an Error whose
  // message includes 'aborted due to timeout' (timings differ by runtime version).
  // Prettier (prettier/prettier eslint rule, --max-warnings 0) removes parens around
  // `a === x || b === y` compound booleans as unnecessary. HC #16 / Gate 14's
  // "parenthesize boolean sub-expressions" rule targets mixed-precedence cases
  // (e.g. `a && b || c`); a simple `||` over two `===` checks is unambiguous.
  // Defer to Prettier. See Maciver 2026-04-16 LOW unparenthesizedTimeoutPredicate.
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
    `  • Path suffix missing — try ${endpoint.replace(/\/?$/, '/graphql')}`,
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
 * Returns the exit code from the body, or 1 on error.
 */
export async function withTracking(opts: WithTrackingOptions): Promise<number> {
  const { context, command, flagsPayload, quiet, body } = opts;
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
    // B15 (#588): Read CliError.exitCode instead of hardcoding 1
    const exitCode = err instanceof CliError ? err.exitCode : 1;
    context.tracker.track({
      type: 'cli.command.failed',
      timestamp: new Date().toISOString(), // determinism:allowed
      tenantId: context.tenantId,
      properties: {
        command,
        durationMs,
        error: sanitizeEventError(err instanceof Error ? err.message : String(err)),
        errorClass: err instanceof Error ? err.name : 'Unknown',
      },
    });
    if (!quiet) {
      const ui = detectUi({
        quiet,
        noColor: (flagsPayload as { noColor?: boolean }).noColor === true,
      });
      printError(
        err instanceof Error ? err : new Error(String(err)),
        ui,
        Boolean((flagsPayload as { debug?: boolean }).debug),
      );
    }
    return exitCode;
  }
}

function camelCase(flag: string): string {
  return flag.replaceAll(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
}

/** Parse a --flag arg, returning the number of consumed tokens. */
function parseFlag(argv: string[], i: number, flags: Record<string, unknown>): number {
  const arg = argv.at(i);
  if (!arg) throw new Error(`parseFlag: argv index ${i} out of bounds (length ${argv.length})`);
  const eq = arg.indexOf('=');
  if (eq > 0) {
    recordSet(flags, camelCase(arg.slice(2, eq)), arg.slice(eq + 1));
    return 1;
  }
  const key = camelCase(arg.slice(2));
  // B27 (#607): Check for single-dash flags (-v, -h) — don't consume them as values
  const nextArg = i + 1 < argv.length ? argv.at(i + 1) : undefined;
  if (nextArg !== undefined && !nextArg.startsWith('-')) {
    recordSet(flags, key, nextArg);
    return 2;
  }
  recordSet(flags, key, true);
  return 1;
}

/**
 * Parse argv: first positional (non-flag) = command; remaining args as flags.
 * Supports --key value, --key=value, --flag (boolean).
 */
export function parseArgs(argv: string[]): { command: string; flags: Record<string, unknown> } {
  const flags: Record<string, unknown> = {};
  let command = '';
  let i = 0;

  while (i < argv.length) {
    const arg = argv.at(i);
    if (!arg) throw new Error(`parseArgs: argv index ${i} out of bounds (length ${argv.length})`);
    if (arg === '--') {
      i++;
      break;
    }
    if (arg.startsWith('--')) {
      i += parseFlag(argv, i, flags);
      continue;
    }
    if (command) {
      recordSet(flags, `_${String(i)}`, arg);
    } else {
      command = arg;
    }
    i++;
  }

  while (i < argv.length) {
    const positional = argv.at(i);
    if (positional === undefined) {
      throw new Error(
        `Expected positional argument at index ${i} but argv.at(${i}) returned undefined`,
      );
    }
    recordSet(flags, `_${String(i)}`, positional);
    i++;
  }

  return { command: command || '', flags };
}

/**
 * Build a synthetic TenantConfig for ad-hoc scans (no tenant YAML).
 * Endpoint comes from .dino.yml directly. All agents disabled (scan uses tools, not agents).
 * Request timeout uses the default from #560.
 */
function buildAdHocTenantConfig(
  endpoint: string,
  protocol: 'graphql',
  requestTimeoutMs: number,
): TenantConfig {
  return {
    schemaVersion: 1,
    id: 'adhoc',
    name: 'Ad-hoc scan',
    apis: [{ name: 'default', type: protocol, source: 'introspection' }],
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

/**
 * Build CommandContext from flags + optional config. Flags take precedence over config.
 */
export function buildContext(flags: CommonFlags, config: DinoCliConfig | null): CommandContext {
  const tenantId = flags.tenant ?? config?.tenant ?? '';

  // #560: Ad-hoc mode — endpoint provided directly, no tenant needed
  if (!tenantId && config?.endpoint) {
    const tenantConfig = buildAdHocTenantConfig(
      config.endpoint,
      config.protocol ?? 'graphql',
      30_000, // DEFAULT_SCAN_CONFIG.requestTimeoutMs — hardcoded to avoid circular dep
    );
    const tracker = createTracker({
      adapter: createCliAnalyticsAdapter(),
      tenantId: 'adhoc',
    });
    return { tenantConfig, tenantId: 'adhoc', environment: 'default', tracker };
  }

  if (!tenantId) {
    throw new CliError(
      'tenant is required (--tenant <id> or set in .dino.yml). ' +
        'Or provide endpoint + protocol for an ad-hoc scan.',
      1,
      'Run dino init to create a .dino.yml config.',
    );
  }
  const tenantConfig = loadTenantById(tenantId);
  const environment = flags.env ?? config?.environment ?? tenantConfig.defaultEnvironment;
  const tracker = createTracker({
    adapter: createCliAnalyticsAdapter(),
    tenantId,
  });
  return {
    tenantConfig,
    tenantId,
    environment,
    tracker,
  };
}
