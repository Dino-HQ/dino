/**
 * @dino/cli — Shared types and helpers for all commands.
 * Spec: docs/CLI_SPEC.md §2–4
 */

import { loadTenantById, recordGet, recordSet } from '@dino/core';
import type { TenantConfig, GraphQLOperation } from '@dino/core';
import {
  createTracker,
  createConsoleAdapter,
  sanitizeEventError,
  sanitizeCliFlags,
} from '@dino/analytics';
import type { Tracker } from '@dino/analytics';
import { createDiscoveryBridge } from '@introspection/create-discovery-bridge';
import type { DinoCliConfig } from '../config/loader';
import { CliError } from './errors';
import { CLI_VERSION } from '../version';
import { printError, detectUi } from './ui';

/** Parsed CLI flags common to all commands */
export interface CommonFlags {
  tenant: string;
  env?: string;
  format?: 'markdown' | 'json';
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  noColor?: boolean;
}

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

/**
 * Run introspection discovery and return validated GraphQL operations.
 * Shared by scan, docs, and diff commands.
 */
export async function discoverOperations(context: CommandContext): Promise<GraphQLOperation[]> {
  const endpoint = getEndpoint(context);
  // getEndpoint() already validated environments + environment key — envConfig is guaranteed non-null
  const envConfig = recordGet(context.tenantConfig.environments, context.environment)!;
  const plugin = createDiscoveryBridge({
    tenant: context.tenantConfig,
    environment: context.environment,
  });

  let discoveryResult;
  try {
    discoveryResult = await plugin.discover({
      endpoint,
      timeout: envConfig.timeout,
    });
  } catch (err: unknown) {
    if (isIntrospectionTimeout(err)) {
      throw buildIntrospectionTimeoutError(endpoint, envConfig.timeout, err);
    }
    throw err;
  }

  if (
    !discoveryResult.raw ||
    !Array.isArray((discoveryResult.raw as { operations?: unknown }).operations)
  ) {
    throw new CliError(
      'Discovery returned no operations',
      1,
      'Confirm the endpoint supports GraphQL introspection.',
    );
  }
  return (discoveryResult.raw as { operations: GraphQLOperation[] }).operations;
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

/**
 * Wrap a command body with analytics tracking (invoked/completed/failed).
 * Returns the exit code from the body, or 1 on error.
 */
export async function withTracking(
  context: CommandContext,
  command: string,
  flagsPayload: Record<string, unknown>,
  quiet: boolean | undefined,
  body: () => Promise<number>,
): Promise<number> {
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
  const arg = argv.at(i)!;
  const eq = arg.indexOf('=');
  if (eq > 0) {
    recordSet(flags, camelCase(arg.slice(2, eq)), arg.slice(eq + 1));
    return 1;
  }
  const key = camelCase(arg.slice(2));
  // B27 (#607): Check for single-dash flags (-v, -h) — don't consume them as values
  if (i + 1 < argv.length && !argv.at(i + 1)!.startsWith('-')) {
    recordSet(flags, key, argv.at(i + 1)!);
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
    const arg = argv.at(i)!;
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
    recordSet(flags, `_${String(i)}`, argv.at(i)!);
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
      adapter: createConsoleAdapter(),
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
    adapter: createConsoleAdapter(),
    tenantId,
  });
  return {
    tenantConfig,
    tenantId,
    environment,
    tracker,
  };
}
