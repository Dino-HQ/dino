// @internal — extracted from (parent module) for max-lines compliance. Tested via (parent module).test.ts
/**
 * @dino/cli — scan pipeline execution, catalog building, and output rendering.
 * Extracted from scan-helpers.ts for max-lines compliance.
 */

import {
  loadOperationRegistry,
  getAllOperations,
  hasOperationsFile,
  buildCatalog,
  renderCatalogMarkdown,
  renderCatalogJson,
  buildSnapshot,
  saveSnapshot,
  runPipeline,
  safePath,
  type PipelineExecutor,
  type TokenResolver,
  type ToolName,
} from '@dino/engine';
import { buildAdHocRegistry, buildAdHocOperationMappings } from './scan-helpers';
import { shouldRenderInkView } from '../ink/InkRender';
import {
  DEFAULT_REASONING_OPTS,
  computeGlobalHealthScore,
  perOpFindingsFromEnv,
} from '../shared/pipeline-helpers';
import { detectUi, colorize, healthLabel } from '../shared/ui';
import { CLI_VERSION } from '../version';
import type { ScanFlags } from './scan';
import type { CommandContext } from '../shared/base-command';
import type { createRestExecutor, DefaultExpectationsMap, ExpectationsMap } from '@dino/agents';
import type { ResolvedScanConfig, GraphQLOperation, Operation, ResultEnvelope } from '@dino/core';

export type ScanPipelineRunResult = Awaited<ReturnType<typeof runPipeline>>;

function shouldFallBackToAdHocRegistry(context: CommandContext): boolean {
  return context.tenantId === 'adhoc' || !hasOperationsFile(context.tenantId);
}

function logAdHocRegistryHintIfNeeded(context: CommandContext, useAdHocFallback: boolean): void {
  if (useAdHocFallback && context.tenantId !== 'adhoc') {
    console.info(
      `No operations file found for "${context.tenantId}" \u2014 auto-generating from introspection.`,
    );
  }
}

type ScanPipelinePhaseParams = {
  context: CommandContext;
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  graphqlOps: GraphQLOperation[];
  executor: PipelineExecutor;
  tokenResolver: TokenResolver | undefined;
  effectiveTools: ToolName[] | undefined;
  validatedModules: string[] | undefined;
  rbacRoles: string[] | undefined;
  rbacExpectations: ExpectationsMap | undefined;
  rbacDefaultExpectations: DefaultExpectationsMap | undefined;
  useAdHocFallback: boolean;
  restExecutor: ReturnType<typeof createRestExecutor> | undefined;
  restBaseUrl: string | undefined;
  openApiSpec: unknown;
  restOperations: Operation[] | undefined;
};

async function runScanPipelinePhase(
  params: ScanPipelinePhaseParams,
): Promise<ScanPipelineRunResult> {
  const {
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
    useAdHocFallback,
    restExecutor,
    restBaseUrl,
    openApiSpec,
    restOperations,
  } = params;
  return runPipeline({
    tenantId: context.tenantId,
    environment: context.environment,
    trigger: 'manual',
    registry: useAdHocFallback
      ? buildAdHocRegistry(graphqlOps, context.tenantId)
      : loadOperationRegistry(context.tenantId),
    executor,
    tokenResolver,
    rbacRoles,
    rbacExpectations,
    rbacDefaultExpectations,
    tools: effectiveTools,
    modules: validatedModules,
    perOpFindings: perOpFindingsFromEnv(),
    reasoningConfig: flags.reasoning
      ? undefined
      : { ...DEFAULT_REASONING_OPTS, enabled: false, apiKey: null },
    tracker: context.tracker,
    timeoutMs: resolvedConfig.timeoutMs,
    restExecutor,
    restBaseUrl,
    openApiSpec,
    restOperations,
  });
}

function warnIfScanReportDegraded(result: ScanPipelineRunResult): void {
  if ('degraded' in result.report && result.report.degraded) {
    console.warn(
      'WARNING: Pipeline ran in degraded mode \u2014 all tools failed. Report contains no test data.',
    );
  }
}

function buildScanCatalogFromResult(params: {
  result: ScanPipelineRunResult;
  graphqlOps: GraphQLOperation[];
  context: CommandContext;
  useAdHocFallback: boolean;
  restOperations?: Operation[] | undefined;
}) {
  const { result, graphqlOps, context, useAdHocFallback, restOperations } = params;
  return buildCatalog({
    introspection: graphqlOps,
    report: {
      ...result.report,
      envelopes: result.envelopesForCatalog ?? result.report.envelopes,
    },
    registry: useAdHocFallback
      ? buildAdHocOperationMappings(graphqlOps, context.tenantId)
      : getAllOperations(context.tenantId),
    timestamp: new Date().toISOString(), // determinism:allowed
    restOperations,
  });
}

async function persistScanSnapshot(params: {
  resolvedConfig: ResolvedScanConfig;
  graphqlOps: GraphQLOperation[];
  context: CommandContext;
}): Promise<void> {
  const { resolvedConfig, graphqlOps, context } = params;
  const snapshotDir = safePath(resolvedConfig.snapshotDir);
  const snapshot = buildSnapshot({
    introspection: graphqlOps,
    tenantId: context.tenantId,
    environment: context.environment,
  });
  await saveSnapshot(snapshot, {
    snapshotDir,
    tenantId: context.tenantId,
    environment: context.environment,
  });
}

function formatScanCatalogForOutput(
  catalog: ReturnType<typeof buildCatalog>,
  format: ResolvedScanConfig['format'],
): string {
  if (format === 'json') {
    return JSON.stringify(renderCatalogJson(catalog), null, 2);
  }
  return renderCatalogMarkdown(catalog);
}

async function tryRenderScanInkSummary(params: {
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  context: CommandContext;
  graphqlOps: GraphQLOperation[];
  result: ScanPipelineRunResult;
}): Promise<boolean> {
  const { flags, resolvedConfig, context, graphqlOps, result } = params;
  const uiSummary = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  if (!shouldRenderInkView(uiSummary, { format: resolvedConfig.format, quiet: flags.quiet })) {
    return false;
  }
  try {
    const React = await import('react');
    const { renderViewSafe } = await import('../ink/InkRender');
    const { ScanView } = await import('../views/ScanView');
    const findingCount = result.condensed.envelopes.flatMap((e) => e.findings).length;
    const healthScore = computeGlobalHealthScore(result.condensed);
    return renderViewSafe(
      React.createElement(ScanView, {
        version: CLI_VERSION,
        tenant: context.tenantId,
        environment: context.environment,
        operationCount: graphqlOps.length,
        healthScore,
        findingCount,
        toolsRun: result.metadata.toolsRun.length,
        breakingChanges: 0,
        durationMs: result.durationMs,
        degraded: Boolean(result.report.degraded),
        colored: uiSummary.colored,
      }),
    );
  } catch (error_) {
    console.warn(
      '[dino] Ink scan view failed:',
      error_ instanceof Error ? error_.message : String(error_),
    );
    return false;
  }
}

function printScanConsoleFooterIfNeeded(params: {
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  graphqlOps: GraphQLOperation[];
  result: ScanPipelineRunResult;
  inkSummaryShown: boolean;
}): void {
  const { flags, resolvedConfig, graphqlOps, result, inkSummaryShown } = params;
  if (flags.quiet || resolvedConfig.format === 'json' || inkSummaryShown) return;
  const uiSummary = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  const findingCount = result.condensed.envelopes.flatMap((e) => e.findings).length;
  const healthScore = computeGlobalHealthScore(result.condensed);
  const summary = [
    `${graphqlOps.length} operations tested`,
    `${findingCount} findings`,
    `health ${healthLabel(healthScore, uiSummary)}`,
  ].join(' \u00B7 ');
  console.info(colorize(summary, 'dim', uiSummary));
}

export interface PipelineCatalogOptions {
  context: CommandContext;
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  graphqlOps: GraphQLOperation[];
  executor: PipelineExecutor;
  tokenResolver: TokenResolver | undefined;
  effectiveTools: ToolName[] | undefined;
  validatedModules: string[] | undefined;
  rbacRoles: string[] | undefined;
  rbacExpectations: ExpectationsMap | undefined;
  rbacDefaultExpectations: DefaultExpectationsMap | undefined;
  restExecutor: ReturnType<typeof createRestExecutor> | undefined;
  restBaseUrl: string | undefined;
  openApiSpec: unknown;
  restOperations: Operation[] | undefined;
}

async function runPipelineAndBuildCatalog(options: PipelineCatalogOptions) {
  const { context, flags, resolvedConfig, graphqlOps, restOperations, ...pipelineParams } = options;
  const useAdHocFallback = shouldFallBackToAdHocRegistry(context);
  logAdHocRegistryHintIfNeeded(context, useAdHocFallback);

  const result = await runScanPipelinePhase({
    context,
    flags,
    resolvedConfig,
    graphqlOps,
    useAdHocFallback,
    restOperations,
    ...pipelineParams,
  });

  warnIfScanReportDegraded(result);

  const catalog = buildScanCatalogFromResult({
    result,
    graphqlOps,
    context,
    useAdHocFallback,
    restOperations,
  });

  return { result, catalog };
}

async function outputScanResults(params: {
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  context: CommandContext;
  graphqlOps: GraphQLOperation[];
  result: ScanPipelineRunResult;
  catalog: ReturnType<typeof buildCatalog>;
}): Promise<number> {
  const { flags, resolvedConfig, context, graphqlOps, result, catalog } = params;

  await persistScanSnapshot({ resolvedConfig, graphqlOps, context });

  const output = formatScanCatalogForOutput(catalog, resolvedConfig.format);
  if (!flags.quiet) {
    console.info(output);
  }

  const inkSummaryShown = await tryRenderScanInkSummary({
    flags,
    resolvedConfig,
    context,
    graphqlOps,
    result,
  });

  printScanConsoleFooterIfNeeded({ flags, resolvedConfig, graphqlOps, result, inkSummaryShown });

  return getScanExitCode(result, flags.failOnHigh);
}

export async function runPipelineCatalogSnapshotAndPrint(
  options: PipelineCatalogOptions,
): Promise<number> {
  const { result, catalog } = await runPipelineAndBuildCatalog(options);

  return outputScanResults({
    flags: options.flags,
    resolvedConfig: options.resolvedConfig,
    context: options.context,
    graphqlOps: options.graphqlOps,
    result,
    catalog,
  });
}

/** Exit code from pipeline result (#572, #1012). Exported for regression tests. */
export function getScanExitCode(
  result: { report: { degraded?: boolean; envelopes?: ResultEnvelope[] } },
  failOnHigh: boolean = false,
): number {
  if (result.report.degraded) return 1;
  if (failOnHigh && hasHighOrCriticalFindings(result.report.envelopes)) return 1;
  return 0;
}

function hasHighOrCriticalFindings(envelopes?: ResultEnvelope[]): boolean {
  if (!envelopes) return false;
  return envelopes.some((e) => e.severity.level === 'CRITICAL' || e.severity.level === 'HIGH');
}
