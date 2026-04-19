/**
 * @dino/cli — dino scan (full pipeline + API Intelligence Report).
 * Spec: docs/CLI_SPEC.md §5.1
 */

import type { CommandContext, CommonFlags } from '../shared/base-command';
import { getEndpoint, discoverOperationsDetailed, withTracking } from '../shared/base-command';
import { CliError } from '../shared/errors';
import {
  loadOperationRegistry,
  getAllOperations,
  hasOperationsFile,
  type OperationMapping,
} from '@reporters/operation-mapper';
import {
  buildCatalog,
  renderCatalogMarkdown,
  renderCatalogJson,
  buildSnapshot,
  saveSnapshot,
} from '@intelligence';
import { runPipeline } from '@pipeline/runner';
import { safePath } from '@utils/safe-path';
import type {
  PipelineExecutor,
  TokenResolver,
  ToolName,
} from '../../../../src/pipeline/runner.types';
import {
  DEFAULT_REASONING_OPTS,
  validateTools,
  validateModules,
  createExecutor,
  withAuth,
  buildTokenResolver,
  validateRbacRoles,
  validateConfigConsistency,
  VALID_TOOL_NAMES,
  computeGlobalHealthScore,
} from '../shared/pipeline-helpers';
import { detectUi, createSpinner, colorize, healthLabel } from '../shared/ui';
import { shouldRenderInkView } from '../ink/render';
import { CLI_VERSION } from '../version';
import { createTokenFactory } from '@shared/auth/token-factory';
import { createAuthAdapter } from '@shared/auth/adapter-factory';
import { resolveConfig } from '@dino/core';
import type { ResolvedScanConfig, GraphQLOperation, Operation, ResultEnvelope } from '@dino/core';
import { createRestExecutor } from '@dino/agents';

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
 * Build an operation registry from introspection results for ad-hoc scans (#953).
 * Groups operations by type: `adhoc:query`, `adhoc:mutation`, `adhoc:subscription`.
 *
 * @internal Exported for unit tests (#953).
 */
export function buildAdHocRegistry(
  ops: GraphQLOperation[],
  moduleSlug: string = 'adhoc',
): Record<string, string[]> {
  const queries: string[] = [];
  const mutations: string[] = [];
  const subscriptions: string[] = [];
  for (const op of ops) {
    switch (op.type) {
      case 'query':
        queries.push(op.name);
        break;
      case 'mutation':
        mutations.push(op.name);
        break;
      case 'subscription':
        subscriptions.push(op.name);
        break;
      default: {
        const _exhaustive: never = op.type;
        throw new Error(`Unexpected operation type: ${String(_exhaustive)}`);
      }
    }
  }
  const registry: Record<string, string[]> = {};
  if (queries.length > 0) {
    registry[`${moduleSlug}:query`] = queries;
  }
  if (mutations.length > 0) {
    registry[`${moduleSlug}:mutation`] = mutations;
  }
  if (subscriptions.length > 0) {
    registry[`${moduleSlug}:subscription`] = subscriptions;
  }
  return registry;
}

/**
 * Build minimal OperationMapping[] from introspection for ad-hoc scans (#953).
 * All operations have coverageStatus `absent` (no external coverage in ad-hoc mode).
 *
 * @internal Exported for unit tests (#953).
 */
export function buildAdHocOperationMappings(
  ops: GraphQLOperation[],
  moduleSlug: string = 'adhoc',
): OperationMapping[] {
  return ops.map((op) => ({
    name: op.name,
    type: op.type,
    module: moduleSlug,
    coverageCollection: null,
    coverageStatus: 'absent' as const,
    testFiles: [],
  }));
}

function logVerboseDefaultsForScan(flags: ScanFlags, resolved: ResolvedScanConfig): void {
  if (!resolved.verbose) {
    return;
  }
  const optionalLines = [
    flags.format ? null : `  format: ${resolved.format}`,
    flags.timeout ? null : `  timeoutMs: ${String(resolved.timeoutMs)}`,
    flags.snapshotDir ? null : `  snapshotDir: ${resolved.snapshotDir}`,
  ].filter((line): line is string => line !== null);
  const lines = [
    ...optionalLines,
    `  concurrency: ${String(resolved.concurrency)}`,
    `  outputDir: ${resolved.outputDir}`,
  ];
  console.info(`[dino] Applied defaults (#560):\n${lines.join('\n')}`);
}

interface ScanToolsAndModules {
  effectiveTools: ToolName[] | undefined;
  validatedModules: string[] | undefined;
}

function prepareScanToolsAndModules(
  context: CommandContext,
  flags: ScanFlags,
  resolved: ResolvedScanConfig,
): ScanToolsAndModules {
  const validatedTools = flags.tools ? validateTools(flags.tools) : undefined;
  const authAbsent = !resolved.auth?.enabled;
  const effectiveTools: ToolName[] | undefined = authAbsent
    ? ((validatedTools ?? ([...VALID_TOOL_NAMES] as ToolName[])).filter(
        (t) => t !== 'rbac-matrix',
      ) as ToolName[])
    : validatedTools;

  if (authAbsent && flags.tools?.includes('rbac-matrix')) {
    console.warn(
      '⚠️  --tools includes rbac-matrix but no auth is configured. ' +
        'RBAC tool skipped to prevent false-positive results. Configure auth to enable RBAC.',
    );
  }

  const validatedModules = flags.modules
    ? validateModules(flags.modules, context.tenantId)
    : undefined;

  return { effectiveTools, validatedModules };
}

function assertReasoningRequiresApiKey(flags: ScanFlags): void {
  const aiKey = flags.aiKey ?? process.env.DINO_AI_KEY;
  if (flags.reasoning && !aiKey) {
    throw new CliError(
      'AI reasoning requires an API key. Set DINO_AI_KEY env var or add aiKey to .dino.yml',
    );
  }
}

function logRbacRolesHintWhenMissing(
  context: CommandContext,
  rbacRoles: string[] | undefined,
): void {
  if ((!rbacRoles || rbacRoles.length === 0) && context.tenantId !== 'adhoc') {
    console.info(
      'No rbac.roles in tenant config — skipping RBAC matrix. Add an rbac: section to your tenant YAML to enable.',
    );
  }
}

function buildScanExecutor(
  context: CommandContext,
  flags: ScanFlags,
  endpoint: string,
): { executor: PipelineExecutor; tokenResolver: TokenResolver | undefined } {
  let executor = createExecutor(endpoint);
  let tokenResolver: TokenResolver | undefined;
  const auth = flags.auth;

  if (auth?.enabled) {
    const tokenFactory = createTokenFactory({
      endpoint,
      tenantId: context.tenantId,
      adapter: createAuthAdapter(context.tenantConfig.auth),
      refreshBufferMs: (context.tenantConfig.auth?.tokenRefresh?.expiryBuffer ?? 60) * 1000,
    });
    executor = withAuth(executor, tokenFactory, auth.role ?? 'USER');
    tokenResolver = buildTokenResolver(tokenFactory);
  } else {
    console.warn('⚠️  No auth config — running unauthenticated. RBAC matrix skipped.');
  }

  return { executor, tokenResolver };
}

function validateRbacIfConfigured(context: CommandContext, rbacRoles: string[] | undefined): void {
  if (rbacRoles) {
    validateRbacRoles(rbacRoles, context.tenantConfig.auth?.roles);
  }
  if (rbacRoles && context.tenantConfig.auth?.roles) {
    validateConfigConsistency(rbacRoles, context.tenantConfig.auth.roles);
  }
}

function readRbacRolesFromContext(context: CommandContext): string[] | undefined {
  return (context.tenantConfig as { rbac?: { roles?: string[] } }).rbac?.roles;
}

type ScanPipelineRunResult = Awaited<ReturnType<typeof runPipeline>>;

function shouldFallBackToAdHocRegistry(context: CommandContext): boolean {
  return context.tenantId === 'adhoc' || !hasOperationsFile(context.tenantId);
}

function logAdHocRegistryHintIfNeeded(context: CommandContext, useAdHocFallback: boolean): void {
  if (useAdHocFallback && context.tenantId !== 'adhoc') {
    console.info(
      `No operations file found for "${context.tenantId}" — auto-generating from introspection.`,
    );
  }
}

async function runScanPipelinePhase(params: {
  context: CommandContext;
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  graphqlOps: GraphQLOperation[];
  executor: PipelineExecutor;
  tokenResolver: TokenResolver | undefined;
  effectiveTools: ToolName[] | undefined;
  validatedModules: string[] | undefined;
  rbacRoles: string[] | undefined;
  useAdHocFallback: boolean;
  restExecutor: ReturnType<typeof createRestExecutor> | undefined;
  restBaseUrl: string | undefined;
  openApiSpec: unknown;
  restOperations: Operation[] | undefined;
}): Promise<ScanPipelineRunResult> {
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
    tools: effectiveTools,
    modules: validatedModules,
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
      'WARNING: Pipeline ran in degraded mode — all tools failed. Report contains no test data.',
    );
  }
}

function buildScanCatalogFromResult(params: {
  result: ScanPipelineRunResult;
  graphqlOps: GraphQLOperation[];
  context: CommandContext;
  useAdHocFallback: boolean;
  restOperations?: Operation[];
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
  const snapshot = buildSnapshot(graphqlOps, context.tenantId, context.environment);
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
    const { renderViewSafe } = await import('../ink/render');
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
  } catch (inkErr) {
    console.warn(
      '[dino] Ink scan view failed:',
      inkErr instanceof Error ? inkErr.message : String(inkErr),
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
  ].join(' · ');
  console.info(colorize(summary, 'dim', uiSummary));
}

async function runPipelineCatalogSnapshotAndPrint(options: {
  context: CommandContext;
  flags: ScanFlags;
  resolvedConfig: ResolvedScanConfig;
  graphqlOps: GraphQLOperation[];
  executor: PipelineExecutor;
  tokenResolver: TokenResolver | undefined;
  effectiveTools: ToolName[] | undefined;
  validatedModules: string[] | undefined;
  rbacRoles: string[] | undefined;
  restExecutor: ReturnType<typeof createRestExecutor> | undefined;
  restBaseUrl: string | undefined;
  openApiSpec: unknown;
  restOperations: Operation[] | undefined;
}): Promise<number> {
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
    restExecutor,
    restBaseUrl,
    openApiSpec,
    restOperations,
  } = options;

  const useAdHocFallback = shouldFallBackToAdHocRegistry(context);
  logAdHocRegistryHintIfNeeded(context, useAdHocFallback);

  const result = await runScanPipelinePhase({
    context,
    flags,
    resolvedConfig,
    graphqlOps,
    executor,
    tokenResolver,
    effectiveTools,
    validatedModules,
    rbacRoles,
    useAdHocFallback,
    restExecutor,
    restBaseUrl,
    openApiSpec,
    restOperations,
  });

  warnIfScanReportDegraded(result);

  const catalog = buildScanCatalogFromResult({
    result,
    graphqlOps,
    context,
    useAdHocFallback,
    restOperations,
  });

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

  printScanConsoleFooterIfNeeded({
    flags,
    resolvedConfig,
    graphqlOps,
    result,
    inkSummaryShown,
  });

  return getScanExitCode(result, flags.failOnHigh);
}

/**
 * dino scan --tenant acme --env qa [--format json] [--reasoning] [--modules X,Y]
 */
export async function runScan(context: CommandContext, flags: ScanFlags): Promise<number> {
  return withTracking(
    context,
    'scan',
    {
      tenant: flags.tenant,
      env: flags.env,
      format: flags.format,
      modules: flags.modules,
      tools: flags.tools,
      reasoning: flags.reasoning,
      debug: flags.debug,
      noColor: flags.noColor,
    },
    flags.quiet,
    async () => {
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
      const { effectiveTools, validatedModules } = prepareScanToolsAndModules(
        context,
        flags,
        resolvedConfig,
      );
      assertReasoningRequiresApiKey(flags);

      const endpoint = getEndpoint(context);
      const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
      const discoverSpinner = createSpinner('Scanning operations…', ui);
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

      logRbacRolesHintWhenMissing(context, rbacRoles);
      const { executor, tokenResolver } = buildScanExecutor(context, flags, endpoint);
      validateRbacIfConfigured(context, rbacRoles);

      const restOps = discoveryMeta.discoveredOperations.filter((op) => op.type === 'rest');
      const hasRest = restOps.length > 0;
      const restExecutor = hasRest
        ? createRestExecutor({ fetch: globalThis.fetch.bind(globalThis) })
        : undefined;
      const restBaseUrl = hasRest ? endpoint : undefined;
      const openApiSpec = hasRest ? discoveryMeta.discoveryRaw : undefined;

      return runPipelineCatalogSnapshotAndPrint({
        context,
        flags,
        resolvedConfig,
        graphqlOps,
        executor,
        tokenResolver,
        effectiveTools,
        validatedModules,
        rbacRoles,
        restExecutor,
        restBaseUrl,
        openApiSpec,
        restOperations: hasRest ? restOps : undefined,
      });
    },
  );
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
