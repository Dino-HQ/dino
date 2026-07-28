// @internal — extracted from (parent module) for max-lines compliance. Tested via (parent module).test.ts
/**
 * @dino/cli — scan command helpers (ad-hoc registry, config, validation).
 * Pipeline execution and output are in scan-pipeline.ts.
 */

import { assertNever } from '@dino/core';
import {
  createTokenFactory,
  createAuthAdapter,
  type OperationMapping,
  type PipelineExecutor,
  type TokenResolver,
  type ToolName,
} from '@dino/engine';
import { CliError } from '../shared/errors';
import {
  validateTools,
  validateModules,
  createExecutor,
  withAuth,
  buildTokenResolver,
  validateRbacRoles,
  validateConfigConsistency,
  VALID_TOOL_NAMES,
} from '../shared/pipeline-helpers';
import type { ScanFlags } from './scan';
import type { CommandContext } from '../shared/base-command';
import type { ResolvedScanConfig, GraphQLOperation } from '@dino/core';

// Re-export pipeline types and functions used by scan.ts
export {
  runPipelineCatalogSnapshotAndPrint,
  getScanExitCode,
  type PipelineCatalogOptions,
} from './scan-pipeline';

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
      default:
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- type narrowing doesn't reach `never` across package boundaries
        assertNever(op.type as never, 'buildAdHocRegistry');
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

export function logVerboseDefaultsForScan(flags: ScanFlags, resolved: ResolvedScanConfig): void {
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

export function prepareScanToolsAndModules(
  context: CommandContext,
  flags: ScanFlags,
  resolved: ResolvedScanConfig,
): ScanToolsAndModules {
  const validatedTools = flags.tools ? validateTools(flags.tools) : undefined;
  const authAbsent = !resolved.auth?.enabled;
  const effectiveTools: ToolName[] | undefined = authAbsent
    ? (validatedTools ?? ([...VALID_TOOL_NAMES] as ToolName[])).filter((t) => t !== 'rbac-matrix')
    : validatedTools;

  if (authAbsent && flags.tools?.includes('rbac-matrix')) {
    console.warn(
      '\u26A0\uFE0F  --tools includes rbac-matrix but no auth is configured. ' +
        'RBAC tool skipped to prevent false-positive results. Configure auth to enable RBAC.',
    );
  }

  const validatedModules = flags.modules
    ? validateModules(flags.modules, context.tenantId)
    : undefined;

  return { effectiveTools, validatedModules };
}

export function assertReasoningRequiresApiKey(flags: ScanFlags): void {
  const aiKey = flags.aiKey ?? process.env.DINO_AI_KEY;
  if (flags.reasoning && !aiKey) {
    throw new CliError(
      'AI reasoning requires an API key. Set DINO_AI_KEY env var or add aiKey to .dino.yml',
    );
  }
}

export function logRbacRolesHintWhenMissing(
  context: CommandContext,
  rbacRoles: string[] | undefined,
): void {
  if ((!rbacRoles || rbacRoles.length === 0) && context.tenantId !== 'adhoc') {
    console.info(
      'No rbac.roles in tenant config \u2014 skipping RBAC matrix. Add an rbac: section to your tenant YAML to enable.',
    );
  }
}

export function buildScanExecutor(
  context: CommandContext,
  flags: ScanFlags,
  endpoint: string,
): { executor: PipelineExecutor; tokenResolver: TokenResolver | undefined } {
  let executor = createExecutor(endpoint);
  let tokenResolver: TokenResolver | undefined;
  const auth = flags.auth;

  if (auth?.enabled && context.tenantConfig.auth) {
    const tokenFactory = createTokenFactory({
      endpoint,
      tenantId: context.tenantId,
      adapter: createAuthAdapter(context.tenantConfig.auth),
      refreshBufferMs: (context.tenantConfig.auth?.tokenRefresh?.expiryBuffer ?? 60) * 1000,
    });
    executor = withAuth(executor, tokenFactory, auth.role ?? 'USER');
    tokenResolver = buildTokenResolver(tokenFactory);
  } else {
    console.warn(
      '\u26A0\uFE0F  No auth config \u2014 running unauthenticated. RBAC matrix skipped.',
    );
  }

  return { executor, tokenResolver };
}

export function validateRbacIfConfigured(
  context: CommandContext,
  rbacRoles: string[] | undefined,
): void {
  if (rbacRoles) {
    validateRbacRoles(rbacRoles, context.tenantConfig.auth?.roles);
  }
  if (rbacRoles && context.tenantConfig.auth?.roles) {
    validateConfigConsistency(rbacRoles, context.tenantConfig.auth.roles);
  }
}

export function readRbacRolesFromContext(context: CommandContext): string[] | undefined {
  return context.tenantConfig.rbac?.roles;
}

export { readRbacExpectationsFromContext } from '../shared/rbac-expectations-read';
