// @internal — extracted from (parent module) for max-lines compliance. Tested via (parent module).test.ts
/**
 * @dino/cli — scan command helpers (ad-hoc registry, config, validation).
 * Pipeline execution and output are in scan-pipeline.ts.
 */

import { TRANSPORT_SUPPLIED_CREDENTIAL } from '@dino/agents';
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

/**
 * #2143: user-relevant product notice on stderr (quiet-aware, no em-dash / winston prefix).
 * #2160: the notice must not claim "no auth is configured" when the user supplied a credential.
 */
function noticeRbacSkipped(context: CommandContext, flags: ScanFlags): void {
  const ui = detectUi({
    quiet: flags.quiet,
    noColor: flags.noColor,
    verbose: flags.verbose,
    debug: flags.debug,
  });
  if (usesStaticHeaderAuth(context)) {
    printNotice(
      'RBAC test skipped: static header auth provides a single credential, not multiple roles.',
      ui,
      { hint: 'Ask for it with --tools rbac-matrix to compare anonymous against that credential.' },
    );
    return;
  }
  printNotice('RBAC test skipped: no auth is configured for this API.', ui, {
    hint: 'Configure auth to test role-based access.',
  });
}

export function prepareScanToolsAndModules(
  context: CommandContext,
  flags: ScanFlags,
  resolved: ResolvedScanConfig,
): ScanToolsAndModules {
  const validatedTools = flags.tools ? validateTools(flags.tools) : undefined;
  // A static credential yields the anonymous-vs-credentialed matrix, so rbac CAN run — but only
  // when it was asked for. Adding it to the default set would plan a cell per operation that
  // admission then withholds, dragging completeness down and turning today's exit 0 into a
  // partial-coverage exit 6 for every existing `--token` scan. Reachable, not imposed.
  const rbacRequested = flags.tools?.includes('rbac-matrix') === true;
  const authAbsent =
    !resolved.auth?.enabled && !(usesStaticHeaderAuth(context) && rbacRequested);
  const effectiveTools: ToolName[] | undefined = authAbsent
    ? (validatedTools ?? ([...VALID_TOOL_NAMES] as ToolName[])).filter((t) => t !== 'rbac-matrix')
    : validatedTools;

  if (authAbsent && flags.tools?.includes('rbac-matrix')) {
    noticeRbacSkipped(context, flags);
  }

  // Every requested tool was dropped as inapplicable. Handing the engine an empty list made it
  // throw "tools array is empty" and exit 70 — a crash, for a user who simply asked for a tool
  // this configuration cannot run. Say which one, and why, as a usage error.
  if (flags.tools !== undefined && effectiveTools?.length === 0) {
    throw new CliError(
      `None of the requested tools can run here: ${flags.tools.join(', ')}.`,
      2,
      'rbac-matrix needs role-based auth (an rbac: section and auth.roles in your tenant config); a single --token credential cannot exercise a role matrix.',
      undefined,
      'usage',
    );
  }

  const validatedModules = flags.modules
    ? validateModules(flags.modules, context.tenantId)
    : undefined;

  return { effectiveTools, validatedModules };
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
  let executor = createExecutor(endpoint, undefined, {
    allowPrivateTarget: flags.allowPrivateTarget === true,
  });
  let tokenResolver: TokenResolver | undefined;
  const auth = flags.auth;

  if (auth?.enabled && context.tenantConfig.auth) {
    const tokenFactory = createTokenFactory({
      endpoint,
      tenantId: context.tenantId,
      allowPrivateTarget: context.allowPrivateTarget,
      adapter: createAuthAdapter(context.tenantConfig.auth, {
        allowPrivateTarget: context.allowPrivateTarget,
      }),
      refreshBufferMs: (context.tenantConfig.auth?.tokenRefresh?.expiryBuffer ?? 60) * 1000,
    });
    executor = withAuth(executor, tokenFactory, auth.role ?? 'USER');
    tokenResolver = buildTokenResolver(tokenFactory);
  } else if (usesStaticHeaderAuth(context)) {
    // #2160: static header auth (flags / flat config). No role matrix, but two auth states: the
    // credential resolves for AD_HOC_AUTHENTICATED_ROLE and nothing resolves for UNAUTHENTICATED,
    // whose cell the executor sends with no credential at all (`unauthenticated`).
    executor = withStaticHeaders(executor, context.authHeaders ?? {});
    // The resolver reports PRESENCE only. `withStaticHeaders` (and the REST wrapper in scan.ts)
    // already send the header verbatim, so handing the value back as a token would re-wrap it as
    // `Bearer <value>` and overwrite the real one.
    tokenResolver = (role: string): Promise<string | null> =>
      Promise.resolve(role === AD_HOC_AUTHENTICATED_ROLE ? TRANSPORT_SUPPLIED_CREDENTIAL : null);
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
  // The two-state matrix is ours, not the tenant's: its credential is the static header the user
  // already supplied, so there is no `auth.roles` entry to check it against.
  const synthesized =
    context.tenantConfig.rbac?.roles === undefined && usesStaticHeaderAuth(context);
  if (synthesized) return;
  if (rbacRoles) {
    validateRbacRoles(rbacRoles, context.tenantConfig.auth?.roles);
  }
  if (rbacRoles && context.tenantConfig.auth?.roles) {
    validateConfigConsistency(rbacRoles, context.tenantConfig.auth.roles);
  }
}

/**
 * The auth state a single supplied credential represents.
 *
 * A `--token` / `--header` scan has no role matrix, but it does have two genuine states: anonymous,
 * and holding that credential. That is enough to answer the question rbac-matrix exists for — is an
 * operation reachable without credentials — which until now no ad-hoc scan could ask at all,
 * because reaching the tool required a tenant YAML, an operations JSON, an `rbac:` section and a
 * specifically-named environment variable.
 */
export const AD_HOC_AUTHENTICATED_ROLE = 'AUTHENTICATED';

/** Exactly what these three read: narrow so callers (and tests) need no whole CommandContext. */
export type AuthHeaderSource = Readonly<{ authHeaders?: Record<string, string> | undefined }>;
export type RbacRoleSource = AuthHeaderSource &
  Readonly<{ tenantConfig: Readonly<{ rbac?: Readonly<{ roles?: string[] | undefined }> | undefined }> }>;

/** True when the only credential is a static header, so the two-state matrix applies. */
export function usesStaticHeaderAuth(context: AuthHeaderSource): boolean {
  return context.authHeaders !== undefined && Object.keys(context.authHeaders).length > 0;
}

/** The supplied credential itself: the Authorization value, or the first header's, minus `Bearer`. */
export function readRbacRolesFromContext(context: RbacRoleSource): string[] | undefined {
  const configured = context.tenantConfig.rbac?.roles;
  if (configured !== undefined && configured.length > 0) return configured;
  return usesStaticHeaderAuth(context)
    ? ['UNAUTHENTICATED', AD_HOC_AUTHENTICATED_ROLE]
    : configured;
}

export { readRbacExpectationsFromContext } from '../shared/rbac-expectations-read';
