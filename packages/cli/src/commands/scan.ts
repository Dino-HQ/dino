/**
 * @dino/cli — dino scan (full pipeline + API Intelligence Report).
 * Spec: docs/CLI_SPEC.md §5.1
 */

import { createRestExecutor } from '@dino/agents';
import { resolveConfig, recordSet, createPinnedFetch } from '@dino/core';
import { isReducedCoverage } from '@dino/engine';
import {
  logVerboseDefaultsForScan,
  prepareScanToolsAndModules,
  logRbacRolesHintWhenMissing,
  buildScanExecutor,
  validateRbacIfConfigured,
  readRbacRolesFromContext,
  readRbacExpectationsFromContext,
  runPipelineCatalogSnapshotAndPrint,
  type PipelineCatalogOptions,
} from './scan-helpers';
import {
  getEndpoint,
  resolveEndpointOrNull,
  discoverOperationsDetailed,
  withTracking,
} from '../shared/base-command';
import { CliError, NeedsInputError } from '../shared/errors';
import { SCAN_ENDPOINT_DESCRIPTOR, resumeArgsForScan } from '../shared/scan-needs-input';
import { detectUi, createSpinner, printNotice, printHeaderBanner } from '../shared/ui';
import { CLI_VERSION } from '../version';
import type { CommandContext, CommonFlags, MergedFlags } from '../shared/base-command';
import type { UiOptions } from '../shared/ui';
import type { ResolvedScanConfig } from '@dino/core';

export { buildAdHocRegistry, buildAdHocOperationMappings } from './scan-helpers';

export interface ScanFlags extends CommonFlags {
  modules?: string[];
  tools?: string[];
  timeout?: number;
  snapshotDir?: string;
  auth?: { enabled: boolean; role?: string };
  verbose?: boolean;
  endpoint?: string | undefined;
  protocol?: 'graphql' | 'rest';
  failOnHigh?: boolean;
  /** Downgrade partial coverage (exit 6) to exit 0 (#2173 INV-1). */
  acceptPartial?: boolean;
  /** Requests per rate-limit burst; a burst below the common limit floor cannot disprove a limit. */
  burst?: number;
}

/**
 * Drop keys whose values are undefined so objects satisfy ScanFlags under exactOptionalPropertyTypes.
 * Safe cast - parseArgs (sole upstream) guarantees field types match ScanFlags via yargs type defs.
 * #2173: coerce `--timeout` string → number; non-numeric → usage CliError (exit 2).
 * #193: reject malformed `--endpoint` before fetch (usage exit 2, not crash 70). Exported for tests.
 */
export function normalizeScanFlags(f: MergedFlags): ScanFlags {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) {
    if (value !== undefined) {
      recordSet(out, key, value);
    }
  }
  coerceTimeoutFlag(out);
  coerceBurstFlag(out);
  coerceEndpointFlag(out);
  return out as ScanFlags;
}

/** #193: reject malformed --endpoint before fetch (usage exit 2, not crash 70). */
function coerceEndpointFlag(out: Record<string, unknown>): void {
  const endpoint = out.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return;
  if (!URL.canParse(endpoint)) {
    throw new CliError(
      `Invalid --endpoint URL: "${endpoint}" (expected a full URL like https://api.example.com)`,
      2,
      'Pass a full URL including the scheme, e.g. --endpoint https://api.example.com/graphql',
      undefined,
      'usage',
    );
  }
}

/**
 * `parseArgs` stores every option value as a string, so `--burst 60` arrives as `"60"` and
 * `ScanFlags.burst: number` is a lie the type system cannot catch. Coerce and validate here, at the
 * boundary, exactly as `--timeout` does — a burst that is not a positive integer is a usage error,
 * not something to forward and let a planner reject deep inside the run.
 */
function coerceBurstFlag(out: Record<string, unknown>): void {
  const raw = out.burst;
  if (raw === undefined) return;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliError(
      `Invalid --burst: "${String(raw)}" (expected a positive whole number of requests)`,
      2,
      'e.g. --burst 61, one request past a 60/min limit and the smallest burst that can disprove one',
      undefined,
      'usage',
    );
  }
  recordSet(out, 'burst', parsed);
}

function coerceTimeoutFlag(out: Record<string, unknown>): void {
  if (out.timeout === undefined) return;
  if (typeof out.timeout === 'number') {
    if (!(Number.isFinite(out.timeout) && out.timeout > 0)) {
      throw new CliError(
        `Invalid --timeout: "${String(out.timeout)}" (expected a positive number of ms)`,
        2,
        'e.g. --timeout 60000',
        undefined,
        'usage',
      );
    }
    return;
  }
  if (typeof out.timeout === 'string') {
    const parsed = Number(out.timeout);
    if (Number.isFinite(parsed) && parsed > 0) {
      recordSet(out, 'timeout', parsed);
      return;
    }
    throw new CliError(
      `Invalid --timeout: "${out.timeout}" (expected a positive number of ms)`,
      2,
      'e.g. --timeout 60000',
      undefined,
      'usage',
    );
  }
  throw new CliError(
    `Invalid --timeout: "${String(out.timeout)}" (expected a positive number of ms)`,
    2,
    'e.g. --timeout 60000',
    undefined,
    'usage',
  );
}

/** #2143: reduced-fidelity product notice, read from the discovery raw introspection result. */
function notifyReducedFidelity(discoveryRaw: unknown, ui: UiOptions): void {
  if (!discoveryRaw || typeof discoveryRaw !== 'object') return;
  const level = (discoveryRaw as { introspectionLevel?: unknown }).introspectionLevel;
  if (typeof level === 'string' && isReducedCoverage(level)) {
    printNotice('Limited schema access: this API only exposes part of its schema.', ui, {
      hint: 'Results are best-effort; connect an OpenAPI/GraphQL spec for full coverage.',
    });
  }
}

/** #2143: brand the run start (TTY, stderr), discover under a spinner, surface reduced fidelity. */
async function discoverWithSpinnerAndBanner(
  context: CommandContext,
  ui: UiOptions,
): Promise<Awaited<ReturnType<typeof discoverOperationsDetailed>>> {
  printHeaderBanner(ui, {
    version: CLI_VERSION,
    command: 'scan',
    tenant: context.tenantId,
    environment: context.environment,
  });
  const discoverSpinner = createSpinner('Testing your API…', ui);
  discoverSpinner.start();
  try {
    const discoveryMeta = await discoverOperationsDetailed(context);
    discoverSpinner.succeed('API tested');
    notifyReducedFidelity(discoveryMeta.discoveryRaw, ui);
    return discoveryMeta;
  } catch (err) {
    discoverSpinner.fail('Test failed');
    throw err;
  }
}

function scanDetectUi(flags: ScanFlags) {
  return detectUi({
    quiet: flags.quiet,
    noColor: flags.noColor,
    verbose: flags.verbose,
    debug: flags.debug,
  });
}

/**
 * Resolve scan endpoint or emit HAR ask_user when unconfigured (#2268).
 * Extracted from discoverAndPrepareScan for max-lines.
 */
function resolveScanEndpointOrAsk(context: CommandContext, flags: ScanFlags): string {
  if (flags.endpoint === undefined && resolveEndpointOrNull(context) === null) {
    throw new NeedsInputError(
      'API endpoint is not configured',
      'Pass --endpoint <url>, or run dino init to configure a tenant with environments/endpoints.',
      [SCAN_ENDPOINT_DESCRIPTOR],
      { type: 'run_command', bin: 'dino', args: resumeArgsForScan(flags) },
    );
  }
  return getEndpoint(context);
}

async function discoverAndPrepareScan(
  context: CommandContext,
  flags: ScanFlags,
  resolvedConfig: ResolvedScanConfig,
): Promise<PipelineCatalogOptions> {
  const { effectiveTools, validatedModules } = prepareScanToolsAndModules(
    context,
    flags,
    resolvedConfig,
  );

  const endpoint = resolveScanEndpointOrAsk(context, flags);
  const discoveryMeta = await discoverWithSpinnerAndBanner(context, scanDetectUi(flags));
  const graphqlOps = discoveryMeta.graphqlOperations;
  const rbacRoles = readRbacRolesFromContext(context);
  const { expectations: rbacExpectations, defaultExpectations: rbacDefaultExpectations } =
    readRbacExpectationsFromContext(context);

  logRbacRolesHintWhenMissing(context, rbacRoles);
  const { executor, tokenResolver } = buildScanExecutor(context, flags, endpoint);
  validateRbacIfConfigured(context, rbacRoles);

  const restOps = discoveryMeta.discoveredOperations.filter((op) => op.type === 'rest');
  const hasRest = restOps.length > 0;

  return {
    context,
    flags,
    resolvedConfig,
    graphqlOps,
    executor,
    tokenResolver,
    effectiveTools,
    validatedModules,
    rbacRoles,
    rbacExpectations,
    rbacDefaultExpectations,
    restExecutor: hasRest
      ? (() => {
          // #1850 - pin the REST scanner's fetch to the validated IP (customer-controlled endpoint).
          // The operator's opt-in has to reach the RUNTIME guard too: the static check passing is
          // not enough, since the pinned fetch re-validates the resolved IP on every hop.
          const base = createRestExecutor({
            fetch: createPinnedFetch({ allowPrivateTarget: flags.allowPrivateTarget === true }),
          });
          const staticHeaders = context.authHeaders;
          if (staticHeaders === undefined || Object.keys(staticHeaders).length === 0) {
            return base;
          }
          // #2160: merge static auth headers; per-call options.headers win on conflict.
          // A probe that declares itself unauthenticated gets none of them — otherwise `--token`
          // silently re-authenticates the one request whose whole purpose is to carry no credential.
          return (operation: Parameters<typeof base>[0], options: Parameters<typeof base>[1]) =>
            base(operation, {
              ...options,
              headers: options.unauthenticated
                ? { ...options.headers }
                : { ...staticHeaders, ...options.headers },
            });
        })()
      : undefined,
    restBaseUrl: hasRest ? endpoint : undefined,
    openApiSpec: hasRest ? discoveryMeta.discoveryRaw : undefined,
    restOperations: hasRest ? restOps : undefined,
    introspectionLevel: discoveryMeta.introspectionLevel,
    structureSource: discoveryMeta.structureSource,
  };
}

async function executeScanBody(context: CommandContext, flags: ScanFlags): Promise<number> {
  const resolvedConfig: ResolvedScanConfig = resolveConfig({
    endpoint: flags.endpoint,
    // resolveConfig's UserConfigInput still types protocol as graphql-only; REST ad-hoc
    // routing uses buildContext/flags, not ResolvedScanConfig.protocol (#206/#2140).
    protocol: flags.protocol === 'graphql' ? 'graphql' : undefined,
    tenant: flags.tenant,
    environment: flags.env,
    // #2143: humans get the readable report by default; `--format json` for machines.
    format: flags.format ?? 'markdown',
    snapshotDir: flags.snapshotDir,
    auth: flags.auth,
    timeout: flags.timeout,
    verbose: flags.verbose,
  });

  logVerboseDefaultsForScan(flags, resolvedConfig);
  const options = await discoverAndPrepareScan(context, flags, resolvedConfig);
  return runPipelineCatalogSnapshotAndPrint(options);
}

/**
 * dino scan --tenant acme --env qa [--format json] [--modules X,Y]
 */
export async function runScan(context: CommandContext, flags: MergedFlags): Promise<number> {
  const scanFlags = normalizeScanFlags(flags);
  return withTracking({
    context,
    command: 'scan',
    flagsPayload: {
      tenant: scanFlags.tenant,
      env: scanFlags.env,
      format: scanFlags.format,
      modules: scanFlags.modules,
      tools: scanFlags.tools,
      debug: scanFlags.debug,
      noColor: scanFlags.noColor,
    },
    quiet: scanFlags.quiet,
    body: () => executeScanBody(context, scanFlags),
  });
}
