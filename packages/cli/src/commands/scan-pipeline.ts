// @internal - extracted from (parent module) for max-lines compliance. Tested via (parent module).test.ts
/**
 * @dino/cli - scan pipeline execution, catalog building, and output rendering.
 * Extracted from scan-helpers.ts for max-lines compliance.
 */

import {
  loadOperationRegistry,
  getAllOperations,
  hasOperationsFile,
  buildCatalog,
  renderCatalogMarkdown,
  buildScanResultV1,
  summarizeCatalogHealth,
  buildSnapshot,
  saveSnapshot,
  runPipeline,
  logger,
  type PipelineExecutor,
  type TokenResolver,
  type ToolName,
} from '@dino/engine';
import { buildAdHocRegistry, buildAdHocOperationMappings } from './scan-helpers';
import { shouldRenderInkView } from '../ink/InkRender';
import { emitResult } from '../shared/emit-result';
import { neutralizeCatalogCustomerFields } from '../shared/neutralize';
import { resolveExitCode, type OutcomeKind } from '../shared/outcome';
import { DEFAULT_REASONING_OPTS, perOpFindingsFromEnv } from '../shared/pipeline-helpers';
import { safeUserPath } from '../shared/safe-user-path';
import { detectUi } from '../shared/ui';
import { CLI_VERSION } from '../version';
import type { ScanFlags } from './scan';
import type { CommandContext } from '../shared/base-command';
import type { createRestExecutor, DefaultExpectationsMap, ExpectationsMap } from '@dino/agents';
import type { ResolvedScanConfig, GraphQLOperation, Operation, ResultEnvelope } from '@dino/core';

export type ScanPipelineRunResult = Awaited<ReturnType<typeof runPipeline>>;

export function shouldFallBackToAdHocRegistry(context: CommandContext): boolean {
  return context.tenantId === 'adhoc' || !hasOperationsFile(context.tenantId);
}

function logAdHocRegistryHintIfNeeded(context: CommandContext, useAdHocFallback: boolean): void {
  if (useAdHocFallback && context.tenantId !== 'adhoc') {
    // #2143: internal detail \u2014 engine logger (stderr, hidden until --verbose), off the stdout report.
    logger.info(
      `No operations file found for "${context.tenantId}": auto-generating from introspection.`,
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
    // #2143: user-relevant \u2014 product voice on stderr (no log prefix, no em-dash).
    console.error('!  All agents failed. No test data was produced for this run.');
  }
}

export function buildScanCatalogFromResult(params: {
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
  const snapshotDir = safeUserPath(resolvedConfig.snapshotDir, '--snapshot-dir');
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

// #2143: the scan report is a QA artifact - title it accordingly. `dino docs`
// keeps its own default (API documentation), so we thread the title here, not in
// the shared renderer default.
const SCAN_REPORT_TITLE = 'API Quality Report';

/** #202: discovery fidelity threaded into the durable scan report */
type ScanIntrospectionLevel = 'full' | 'shallow' | 'minimal';

function isReducedCoverage(level?: ScanIntrospectionLevel): boolean {
  return level === 'minimal' || level === 'shallow';
}

function formatScanCatalogForOutput(
  catalog: ReturnType<typeof buildCatalog>,
  format: ResolvedScanConfig['format'],
  introspectionLevel?: ScanIntrospectionLevel,
): string {
  const ctx = format === 'json' ? 'json' : 'markdown';
  const safeCatalog = catalog.map((entry) => neutralizeCatalogCustomerFields(entry, ctx));
  if (format === 'json') {
    // #2174: versioned ScanResultV1 — validate-before-emit; #2173 partial signal lives in builder.
    const result = buildScanResultV1(safeCatalog, {
      title: SCAN_REPORT_TITLE,
      introspectionLevel,
      toolVersion: CLI_VERSION,
      evidence: 'none',
    });
    return JSON.stringify(result, null, 2);
  }
  return renderCatalogMarkdown(safeCatalog, { title: SCAN_REPORT_TITLE, introspectionLevel });
}

async function tryRenderScanInkSummary(params: {
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  result: ScanPipelineRunResult;
  catalog: ReturnType<typeof buildCatalog>;
  introspectionLevel?: ScanIntrospectionLevel | undefined;
}): Promise<void> {
  const { flags, resolvedConfig, result, catalog, introspectionLevel } = params;
  const uiSummary = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  if (!shouldRenderInkView(uiSummary, { format: resolvedConfig.format, quiet: flags.quiet })) {
    return;
  }
  try {
    const React = await import('react');
    const { renderViewSafe } = await import('../ink/InkRender');
    const { ScanView } = await import('../views/ScanView');
    // #2143 + #2139: the TTY summary MUST match the report. Health comes from the canonical
    // summarizeCatalogHealth (the same verdict the report prints); the operation count comes
    // from the ScanResultV1 core (#2174) - never graphqlOps.length, which is 0 for a REST scan.
    const reportStats = buildScanResultV1(catalog, {
      title: SCAN_REPORT_TITLE,
      introspectionLevel,
      toolVersion: CLI_VERSION,
    });
    const h = summarizeCatalogHealth(catalog);
    const findingCount = (result.condensed.envelopes ?? []).flatMap((e) => e.findings).length;
    const partial = introspectionLevel === 'minimal' || introspectionLevel === 'shallow';
    renderViewSafe(
      React.createElement(ScanView, {
        operationCount: reportStats.core.operationCount,
        healthScore: h.score,
        healthVerdict: h.verdict,
        healthLevel: h.level,
        findingCount,
        toolsRun: result.metadata.toolsRun.length,
        breakingChanges: 0,
        durationMs: result.durationMs,
        degraded: Boolean(result.report.degraded),
        colored: uiSummary.colored,
        partial,
      }),
    );
  } catch (error_) {
    // #2143: Ink render failure is internal - the markdown report already printed to stdout.
    // Log at debug (surfaced only with --debug), off the user's default output.
    logger.debug(
      `[dino] Ink scan view failed: ${error_ instanceof Error ? error_.message : String(error_)}`,
    );
  }
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
  /** #202: discovery fidelity for durable report disclosure */
  introspectionLevel?: ScanIntrospectionLevel | undefined;
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
  introspectionLevel?: ScanIntrospectionLevel | undefined;
}): Promise<number> {
  const { flags, resolvedConfig, context, graphqlOps, result, catalog, introspectionLevel } =
    params;

  await persistScanSnapshot({ resolvedConfig, graphqlOps, context });

  // #2143: the report IS the result - always emit it to stdout, even with --quiet.
  // `--quiet` suppresses chrome (spinner, notices, the Ink summary), never the result.
  // #2172: sole stdout writer is emitResult (INV-1).
  const output = formatScanCatalogForOutput(catalog, resolvedConfig.format, introspectionLevel);
  emitResult(output, {
    format: resolvedConfig.format === 'json' ? 'json' : 'markdown',
  });

  // #2143: in a TTY, render the summary card (mirrors the report's op count + canonical
  // health via summarizeCatalogHealth). No console footer - it was redundant with the report
  // Summary and, on stdout, polluted `> report.md`.
  await tryRenderScanInkSummary({ flags, resolvedConfig, result, catalog, introspectionLevel });

  return getScanExitCode(result, flags.failOnHigh === true, {
    acceptPartial: flags.acceptPartial === true,
    introspectionLevel,
  });
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
    introspectionLevel: options.introspectionLevel,
  });
}

export interface ScanExitCodeOptions {
  acceptPartial?: boolean;
  introspectionLevel?: ScanIntrospectionLevel | undefined;
}

/** Exit code from pipeline result (#572, #1012, #2173). Exported for regression tests. */
export function getScanExitCode(
  result: { report: { degraded?: boolean; envelopes?: ResultEnvelope[] } },
  failOnHigh: boolean = false,
  options?: ScanExitCodeOptions,
): number {
  const kinds: OutcomeKind[] = [];
  const partial = result.report.degraded === true || isReducedCoverage(options?.introspectionLevel);
  if (partial) kinds.push('partial');
  if (failOnHigh && hasHighOrCriticalFindings(result.report.envelopes)) {
    kinds.push('policy');
  }
  const first = kinds[0];
  if (first === undefined) {
    return resolveExitCode({ kind: 'clean' });
  }
  const rest = kinds.slice(1);
  return resolveExitCode({
    kind: first,
    ...(rest.length > 0 ? { also: rest } : {}),
    ...(options?.acceptPartial === true ? { acceptPartial: true } : {}),
  });
}

function hasHighOrCriticalFindings(envelopes?: ResultEnvelope[]): boolean {
  if (!envelopes) return false;
  return envelopes.some((e) => e.severity.level === 'CRITICAL' || e.severity.level === 'HIGH');
}
