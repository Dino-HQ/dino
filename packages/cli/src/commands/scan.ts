/**
 * @dino/cli — dino scan (full pipeline + API Intelligence Report).
 * Spec: docs/CLI_SPEC.md §5.1
 */

import type { CommandContext, CommonFlags } from '../shared/base-command';
import { getEndpoint, discoverOperations, withTracking } from '../shared/base-command';
import { CliError } from '../shared/errors';
import {
  loadOperationRegistry,
  getAllOperations,
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
} from '../shared/pipeline-helpers';
import { createTokenFactory } from '@shared/auth/token-factory';
import { createAuthAdapter } from '@shared/auth/adapter-factory';
import { resolveConfig } from '@dino/core';
import type { ResolvedScanConfig, GraphQLOperation } from '@dino/core';

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
}

/**
 * Build an operation registry from introspection results for ad-hoc scans (#953).
 * Groups operations by type: `adhoc:query`, `adhoc:mutation`, `adhoc:subscription`.
 *
 * @internal Exported for unit tests (#953).
 */
export function buildAdHocRegistry(ops: GraphQLOperation[]): Record<string, string[]> {
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
    registry['adhoc:query'] = queries;
  }
  if (mutations.length > 0) {
    registry['adhoc:mutation'] = mutations;
  }
  if (subscriptions.length > 0) {
    registry['adhoc:subscription'] = subscriptions;
  }
  return registry;
}

/**
 * Build minimal OperationMapping[] from introspection for ad-hoc scans (#953).
 * All operations have coverageStatus `absent` (no external coverage in ad-hoc mode).
 *
 * @internal Exported for unit tests (#953).
 */
export function buildAdHocOperationMappings(ops: GraphQLOperation[]): OperationMapping[] {
  return ops.map((op) => ({
    name: op.name,
    type: op.type,
    module: 'adhoc',
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
  } = options;

  const result = await runPipeline({
    tenantId: context.tenantId,
    environment: context.environment,
    trigger: 'manual',
    registry:
      context.tenantId === 'adhoc'
        ? buildAdHocRegistry(graphqlOps)
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
  });

  if ('degraded' in result.report && result.report.degraded) {
    console.warn(
      'WARNING: Pipeline ran in degraded mode — all tools failed. Report contains no test data.',
    );
  }

  const catalog = buildCatalog({
    introspection: graphqlOps,
    report: {
      ...result.report,
      envelopes: result.envelopesForCatalog ?? result.report.envelopes,
    },
    registry:
      context.tenantId === 'adhoc'
        ? buildAdHocOperationMappings(graphqlOps)
        : getAllOperations(context.tenantId),
    timestamp: new Date().toISOString(), // determinism:allowed
  });

  const snapshotDir = safePath(resolvedConfig.snapshotDir);
  const snapshot = buildSnapshot(graphqlOps, context.tenantId, context.environment);
  await saveSnapshot(snapshot, {
    snapshotDir,
    tenantId: context.tenantId,
    environment: context.environment,
  });

  const output =
    resolvedConfig.format === 'json'
      ? JSON.stringify(renderCatalogJson(catalog), null, 2)
      : renderCatalogMarkdown(catalog);
  if (!flags.quiet) {
    console.info(output);
  }

  return getScanExitCode(result);
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
      const graphqlOps = await discoverOperations(context);
      const rbacRoles = readRbacRolesFromContext(context);

      logRbacRolesHintWhenMissing(context, rbacRoles);
      const { executor, tokenResolver } = buildScanExecutor(context, flags, endpoint);
      validateRbacIfConfigured(context, rbacRoles);

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
      });
    },
  );
}

/** Exit code from pipeline result (#572). Exported for regression tests. */
export function getScanExitCode(result: { report: { degraded?: boolean } }): number {
  return result.report.degraded ? 1 : 0;
}
