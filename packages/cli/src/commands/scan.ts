/**
 * @dino/cli — dino scan (full pipeline + API Intelligence Report).
 * Spec: docs/CLI_SPEC.md §5.1
 */

import { createRestExecutor } from '@dino/agents';
import { resolveConfig, recordSet, createPinnedFetch } from '@dino/core';
import {
  logVerboseDefaultsForScan,
  prepareScanToolsAndModules,
  assertReasoningRequiresApiKey,
  logRbacRolesHintWhenMissing,
  buildScanExecutor,
  validateRbacIfConfigured,
  readRbacRolesFromContext,
  readRbacExpectationsFromContext,
  runPipelineCatalogSnapshotAndPrint,
  type PipelineCatalogOptions,
} from './scan-helpers';
import { ensureScanTelemetryConsent } from '../config/telemetry-consent';
import { getEndpoint, discoverOperationsDetailed, withTracking } from '../shared/base-command';
import { CliError } from '../shared/errors';
import { detectUi, createSpinner, printNotice, printHeaderBanner } from '../shared/ui';
import { CLI_VERSION } from '../version';
import type { CommandContext, CommonFlags, MergedFlags } from '../shared/base-command';
import type { UiOptions } from '../shared/ui';
import type { ResolvedScanConfig } from '@dino/core';

export { buildAdHocRegistry, buildAdHocOperationMappings, getScanExitCode } from './scan-helpers';

export interface ScanFlags extends CommonFlags {
  modules?: string[];
  tools?: string[];
  reasoning?: boolean;
  timeout?: number;
  snapshotDir?: string;
  aiKey?: string;
  auth?: { enabled: boolean; role?: string };
  verbose?: boolean;
  endpoint?: string;
  protocol?: 'graphql' | 'rest';
  failOnHigh?: boolean;
  /** Downgrade partial coverage (exit 6) to exit 0 (#2173 INV-1). */
  acceptPartial?: boolean;
}

/**
 * Drop keys whose values are undefined so objects satisfy ScanFlags under exactOptionalPropertyTypes.
 * Safe cast — parseArgs (sole upstream) guarantees field types match ScanFlags via yargs type defs.
 * #2173: coerce `--timeout` string → number; non-numeric → usage CliError (exit 2).
 */
function normalizeScanFlags(f: MergedFlags): ScanFlags {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) {
    if (value !== undefined) {
      recordSet(out, key, value);
    }
  }
  coerceTimeoutFlag(out);
  return out as ScanFlags;
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
  if (level === 'minimal' || level === 'shallow') {
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
  assertReasoningRequiresApiKey(flags);

  const endpoint = getEndpoint(context);
  const ui = detectUi({
    quiet: flags.quiet,
    noColor: flags.noColor,
    verbose: flags.verbose,
    debug: flags.debug,
  });
  const discoveryMeta = await discoverWithSpinnerAndBanner(context, ui);
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
          const base = createRestExecutor({ fetch: createPinnedFetch() });
          const staticHeaders = context.authHeaders;
          if (staticHeaders === undefined || Object.keys(staticHeaders).length === 0) {
            return base;
          }
          // #2160: merge static auth headers; per-call options.headers win on conflict.
          return (operation: Parameters<typeof base>[0], options: Parameters<typeof base>[1]) =>
            base(operation, {
              ...options,
              headers: { ...staticHeaders, ...options.headers },
            });
        })()
      : undefined,
    restBaseUrl: hasRest ? endpoint : undefined,
    openApiSpec: hasRest ? discoveryMeta.discoveryRaw : undefined,
    restOperations: hasRest ? restOps : undefined,
    // #202: durable report disclosure (stderr notice stays in notifyReducedFidelity)
    introspectionLevel: discoveryMeta.introspectionLevel,
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
    aiKey: flags.aiKey,
    auth: flags.auth,
    timeout: flags.timeout,
    verbose: flags.verbose,
  });

  logVerboseDefaultsForScan(flags, resolvedConfig);
  const options = await discoverAndPrepareScan(context, flags, resolvedConfig);
  return runPipelineCatalogSnapshotAndPrint(options);
}

/**
 * dino scan --tenant acme --env qa [--format json] [--reasoning] [--modules X,Y]
 */
export async function runScan(context: CommandContext, flags: MergedFlags): Promise<number> {
  const scanFlags = normalizeScanFlags(flags);
  await ensureScanTelemetryConsent();
  return withTracking({
    context,
    command: 'scan',
    flagsPayload: {
      tenant: scanFlags.tenant,
      env: scanFlags.env,
      format: scanFlags.format,
      modules: scanFlags.modules,
      tools: scanFlags.tools,
      reasoning: scanFlags.reasoning,
      debug: scanFlags.debug,
      noColor: scanFlags.noColor,
    },
    quiet: scanFlags.quiet,
    body: () => executeScanBody(context, scanFlags),
  });
}
