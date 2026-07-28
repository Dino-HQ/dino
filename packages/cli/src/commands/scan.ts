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
import { detectUi, createSpinner } from '../shared/ui';
import type { CommandContext, CommonFlags, MergedFlags } from '../shared/base-command';
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
  protocol?: 'graphql';
  failOnHigh?: boolean;
}

/**
 * Drop keys whose values are undefined so objects satisfy ScanFlags under exactOptionalPropertyTypes.
 * Safe cast — parseArgs (sole upstream) guarantees field types match ScanFlags via yargs type defs.
 */
function normalizeScanFlags(f: MergedFlags): ScanFlags {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) {
    if (value !== undefined) {
      recordSet(out, key, value);
    }
  }
  return out as ScanFlags;
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
  const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  const discoverSpinner = createSpinner('Scanning operations\u2026', ui);
  discoverSpinner.start();
  let graphqlOps;
  let discoveryMeta: Awaited<ReturnType<typeof discoverOperationsDetailed>>;
  try {
    discoveryMeta = await discoverOperationsDetailed(context);
    graphqlOps = discoveryMeta.graphqlOperations;
    const discoveredCount =
      graphqlOps.length > 0 ? graphqlOps.length : discoveryMeta.discoveredOperations.length;
    discoverSpinner.succeed(`Discovered ${discoveredCount} operations`);
  } catch (err) {
    discoverSpinner.fail('Scan failed');
    throw err;
  }
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
      ? // #1850 — pin the REST scanner's fetch to the validated IP (customer-controlled endpoint).
        createRestExecutor({ fetch: createPinnedFetch() })
      : undefined,
    restBaseUrl: hasRest ? endpoint : undefined,
    openApiSpec: hasRest ? discoveryMeta.discoveryRaw : undefined,
    restOperations: hasRest ? restOps : undefined,
  };
}

async function executeScanBody(context: CommandContext, flags: ScanFlags): Promise<number> {
  const resolvedConfig: ResolvedScanConfig = resolveConfig({
    endpoint: flags.endpoint,
    protocol: flags.protocol,
    tenant: flags.tenant,
    environment: flags.env,
    format: flags.format,
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
