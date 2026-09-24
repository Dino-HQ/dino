// @internal - extracted from (parent module) for max-lines compliance. Tested via (parent module).test.ts
/**
 * @dino/cli - scan pipeline execution and output rendering over the canonical `DinoResult`
 * (Cleanup V2 task 4c): the engine returns the result, the CLI copies its fields into the report,
 * the TTY card and the exit code — nothing is recomputed from a catalog rebuild.
 */

import {
  loadOperationRegistry,
  hasOperationsFile,
  buildSnapshot,
  saveSnapshot,
  runPipeline,
  createFuzzerProjectionContext,
  exitCodeFor,
  logger,
  type PipelineExecutor,
  type TokenResolver,
  type ToolName,
} from '@dino/engine';
import { buildAdHocRegistry } from './scan-helpers';
import { formatScanResultForOutput } from './scan-pipeline-format';
import { shouldRenderInkView } from '../ink/InkRender';
import { emitResult } from '../shared/emit-result';
import { findingMass } from '../shared/finding-mass';
import { discoveryRead, type ScanStructureSource } from '../shared/introspection-level';
import { safeUserPath } from '../shared/safe-user-path';
import { detectUi } from '../shared/ui';
import type { ScanFlags } from './scan';
import type { ScanIntrospectionLevel } from './scan-pipeline-format';
import type { CommandContext } from '../shared/base-command';
import type { ScanViewProps } from '../views/ScanView';
import type { createRestExecutor, DefaultExpectationsMap, ExpectationsMap } from '@dino/agents';
import type { DinoResult, ResolvedScanConfig, GraphQLOperation, Operation } from '@dino/core';

export type ScanPipelineRunResult = DinoResult;

export function shouldFallBackToAdHocRegistry(context: CommandContext): boolean {
  return context.tenantId === 'adhoc' || !hasOperationsFile(context.tenantId);
}

function logAdHocRegistryHintIfNeeded(context: CommandContext, useAdHocFallback: boolean): void {
  if (useAdHocFallback && context.tenantId !== 'adhoc') {
    // #2143: internal detail — engine logger (stderr, hidden until --verbose), off the stdout report.
    logger.info(
      `No operations file found for "${context.tenantId}": auto-generating from introspection.`,
    );
  }
}

type ScanPipelinePhaseParams = {
  context: CommandContext;
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
  introspectionLevel?: ScanIntrospectionLevel | undefined;
  structureSource?: ScanStructureSource | undefined;
  rateLimitBurst?: number | undefined;
};

async function runScanPipelinePhase(params: ScanPipelinePhaseParams): Promise<DinoResult> {
  const {
    context,
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
    introspectionLevel,
    structureSource,
    rateLimitBurst,
  } = params;
  return runPipeline({
    targets: { graphql: context.selectedTarget, rest: context.selectedTarget },
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
    tracker: context.tracker,
    timeoutMs: resolvedConfig.timeoutMs,
    restExecutor,
    restBaseUrl,
    openApiSpec,
    restOperations,
    ...(rateLimitBurst === undefined ? {} : { rateLimitBurst }),
    ...(introspectionLevel === undefined ? {} : { introspectionLevel }),
    discovery: { graphqlOperations: graphqlOps, introspectionLevel, read: discoveryRead({ structureSource, hasRest: restOperations !== undefined }) },
  }, createFuzzerProjectionContext());
}

/** Exported for the scan/diff snapshot-parity regression test. */
export async function persistScanSnapshot(params: {
  resolvedConfig: ResolvedScanConfig;
  graphqlOps: GraphQLOperation[];
  restOperations: readonly Operation[] | undefined;
  context: CommandContext;
}): Promise<void> {
  const { resolvedConfig, graphqlOps, restOperations, context } = params;
  const snapshotDir = safeUserPath(resolvedConfig.snapshotDir, '--snapshot-dir');
  // diff, lint and changelog read this store too and snapshot REST operations, so scan must as
  // well: a GraphQL-only snapshot would make every REST operation look added and hide removals.
  const snapshot = buildSnapshot({
    introspection: graphqlOps,
    ...(restOperations ? { restOperations } : {}),
    tenantId: context.tenantId,
    environment: context.environment,
  });
  await saveSnapshot(snapshot, {
    snapshotDir,
    tenantId: context.tenantId,
    environment: context.environment,
  });
}

/** The TTY card is a pure projection of the canonical result (Cleanup V2 task 4c): every number is copied or summed. */
export function scanViewProps(result: DinoResult, colored: boolean): ScanViewProps {
  const { verdict, verification, findings } = result;
  const records = verification.tools;
  return {
    operationCount: verdict.operationCount,
    healthScore: verdict.health.score,
    healthVerdict: verdict.health.verdict,
    healthLevel: verdict.health.level,
    findingCount: findingMass(findings),
    toolsRun: records.filter((t) => t.status === 'ran').length,
    toolsExcluded: records.filter((t) => t.status === 'excluded').length,
    toolsUnavailable: records.filter((t) => t.status === 'unavailable').length,
    durationMs: verification.durationMs,
    degraded: verdict.degraded,
    colored,
    partial: verdict.coverage === 'partial',
  };
}

/** #2269: exported for cross-surface INV-2 tests: the TTY card copies the same result the report printed. */
export async function tryRenderScanInkSummary(params: {
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  result: DinoResult;
}): Promise<void> {
  const { flags, resolvedConfig, result } = params;
  const uiSummary = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  if (!shouldRenderInkView(uiSummary, { format: resolvedConfig.format, quiet: flags.quiet })) {
    return;
  }
  try {
    const React = await import('react');
    const { renderViewSafe } = await import('../ink/InkRender');
    const { ScanView } = await import('../views/ScanView');
    renderViewSafe(React.createElement(ScanView, scanViewProps(result, uiSummary.colored)));
  } catch (error_) {
    // #2143: Ink render failure is internal - the markdown report already printed to stdout.
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
  /** #2306: structure provenance for report meta */
  structureSource?: 'live' | 'sdl' | undefined;
}

/** #2269: exported for cross-surface tests: the one place the report, the card and the exit code read the result. */
export async function outputScanResult(params: {
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  context: CommandContext;
  graphqlOps: GraphQLOperation[];
  restOperations?: readonly Operation[] | undefined;
  result: DinoResult;
}): Promise<number> {
  const { flags, resolvedConfig, context, graphqlOps, restOperations, result } = params;
  await persistScanSnapshot({ resolvedConfig, graphqlOps, restOperations, context });

  if (result.verdict.degraded) {
    // #2143: user-relevant — product voice on stderr (no log prefix, no em-dash).
    console.error('!  All agents failed. No test data was produced for this run.');
  }
  // #2143: the report IS the result - always emit it to stdout, even with --quiet.
  // #2172: sole stdout writer is emitResult (INV-1). JSON is the canonical bytes, verbatim.
  const output = formatScanResultForOutput(result, resolvedConfig.format);
  emitResult(output, { format: resolvedConfig.format === 'json' ? 'canonical' : 'markdown' });

  await tryRenderScanInkSummary({ flags, resolvedConfig, result });

  // The exit code is owned by the engine (spec §9.4): transient > policy > partial > clean.
  return exitCodeFor(result, { failOnHigh: flags.failOnHigh === true, acceptPartial: flags.acceptPartial === true });
}

export async function runPipelineCatalogSnapshotAndPrint(
  options: PipelineCatalogOptions,
): Promise<number> {
  const { context, flags, resolvedConfig, graphqlOps, restOperations, ...pipelineParams } = options;
  const useAdHocFallback = shouldFallBackToAdHocRegistry(context);
  logAdHocRegistryHintIfNeeded(context, useAdHocFallback);

  const result = await runScanPipelinePhase({
    context,
    resolvedConfig,
    graphqlOps,
    useAdHocFallback,
    restOperations,
    ...(flags.burst === undefined ? {} : { rateLimitBurst: flags.burst }),
    ...pipelineParams,
  });

  return outputScanResult({
    flags,
    resolvedConfig,
    context,
    graphqlOps,
    restOperations,
    result,
  });
}

export { formatScanResultForOutput } from './scan-pipeline-format';
