// @internal — extracted from (parent module) for max-lines compliance. Tested via (parent module).test.ts
/**
 * @dino/cli — scan command helpers (ad-hoc registry, config, validation).
 * Pipeline execution and output are in scan-pipeline.ts.
 */

import { assertNever } from '@dino/core';
import {
  createTokenFactory,
  createAuthAdapter,
  logger,
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
  withStaticHeaders,
  buildTokenResolver,
  validateRbacRoles,
  validateConfigConsistency,
  VALID_TOOL_NAMES,
} from '../shared/pipeline-helpers';
import { detectUi, printNotice } from '../shared/ui';
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
  logger.info(`Applied defaults:\n${lines.join('\n')}`);
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
    // #2143: user-relevant product notice on stderr (quiet-aware, no em-dash / winston prefix).
    // #2160: header auth is still "auth absent" for RBAC (no roles), but the notice must
    // not claim "no auth is configured" when the user supplied a static credential.
    const ui = detectUi({
      quiet: flags.quiet,
      noColor: flags.noColor,
      verbose: flags.verbose,
      debug: flags.debug,
    });
    const hasHeaderAuth =
      context.authHeaders !== undefined && Object.keys(context.authHeaders).length > 0;
    if (hasHeaderAuth) {
      printNotice(
        'RBAC test skipped: static header auth provides a single credential, not multiple roles.',
        ui,
        { hint: 'Configure role-based auth to test the RBAC matrix.' },
      );
    } else {
      printNotice('RBAC test skipped: no auth is configured for this API.', ui, {
        hint: 'Configure auth to test role-based access.',
      });
    }
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
      2,
      'Provide an Anthropic API key when using --reasoning.',
      undefined,
      'usage',
    );
  }
}

export function logRbacRolesHintWhenMissing(
  context: CommandContext,
  rbacRoles: string[] | undefined,
): void {
  if ((!rbacRoles || rbacRoles.length === 0) && context.tenantId !== 'adhoc') {
    logger.info(
      'No rbac.roles in tenant config: skipping RBAC matrix. Add an rbac: section to your tenant YAML to enable.',
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
  } else if (context.authHeaders !== undefined && Object.keys(context.authHeaders).length > 0) {
    // #2160: static header auth (flags / flat config): authenticated, no roles.
    executor = withStaticHeaders(executor, context.authHeaders);
  } else {
    // #2143: product notice on stderr, quiet-aware (suppressed under --quiet).
    const ui = detectUi({
      quiet: flags.quiet,
      noColor: flags.noColor,
      verbose: flags.verbose,
      debug: flags.debug,
    });
    printNotice('Running unauthenticated. Configure auth to test role-based access.', ui);
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
