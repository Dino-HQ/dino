/**
 * @dino/cli — dino scan (full pipeline + API Intelligence Report).
 * Spec: docs/CLI_SPEC.md §5.1
 */

import type { CommandContext, CommonFlags } from '../shared/base-command';
import { getEndpoint, discoverOperations, withTracking } from '../shared/base-command';
import { CliError } from '../shared/errors';
import { loadOperationRegistry, getAllOperations } from '@reporters/operation-mapper';
import {
  buildCatalog,
  renderCatalogMarkdown,
  renderCatalogJson,
  buildSnapshot,
  saveSnapshot,
} from '@intelligence';
import { runPipeline } from '@pipeline/runner';
import { safePath } from '@utils/safe-path';
import type { TokenResolver } from '../../../../src/pipeline/runner.types';
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
import type { ResolvedScanConfig } from '@dino/core';
import type { ToolName } from '../../../../src/pipeline/runner.types';

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
      // #560: Resolve config with smart defaults
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

      // #560: Verbose logging of applied defaults (INV-4: no secrets)
      if (resolvedConfig.verbose) {
        const defaults: string[] = [];
        if (!flags.format) defaults.push(`  format: ${resolvedConfig.format}`);
        if (!flags.timeout) defaults.push(`  timeoutMs: ${String(resolvedConfig.timeoutMs)}`);
        if (!flags.snapshotDir) defaults.push(`  snapshotDir: ${resolvedConfig.snapshotDir}`);
        defaults.push(`  concurrency: ${String(resolvedConfig.concurrency)}`);
        defaults.push(`  outputDir: ${resolvedConfig.outputDir}`);
        if (defaults.length > 0) {
          console.info(`[dino] Applied defaults (#560):\n${defaults.join('\n')}`);
        }
      }

      // Validate --tools and --modules at the CLI boundary
      const validatedTools = flags.tools ? validateTools(flags.tools) : undefined;

      // #560 INV-2: Exclude rbac-matrix when auth is absent
      const authAbsent = !resolvedConfig.auth?.enabled;
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

      // Gate: --reasoning requires an API key (Pro tier)
      const aiKey = flags.aiKey ?? process.env.DINO_AI_KEY;
      if (flags.reasoning && !aiKey) {
        throw new CliError(
          'AI reasoning requires an API key. Set DINO_AI_KEY env var or add aiKey to .dino.yml',
        );
      }

      const endpoint = getEndpoint(context);
      const graphqlOps = await discoverOperations(context);
      const auth = flags.auth;
      let executor = createExecutor(endpoint);

      const rbacRoles: string[] | undefined = (
        context.tenantConfig as { rbac?: { roles?: string[] } }
      ).rbac?.roles;

      // #560: Suppress RBAC guidance noise in ad-hoc mode (no tenant YAML to configure)
      if ((!rbacRoles || rbacRoles.length === 0) && context.tenantId !== 'adhoc') {
        console.info(
          'No rbac.roles in tenant config — skipping RBAC matrix. Add an rbac: section to your tenant YAML to enable.',
        );
      }

      let tokenResolver: TokenResolver | undefined;

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
        // #560: RBAC is now skipped entirely when no auth (INV-2), not just limited to UNAUTHENTICATED
        console.warn('⚠️  No auth config — running unauthenticated. RBAC matrix skipped.');
      }

      if (rbacRoles) {
        validateRbacRoles(rbacRoles, context.tenantConfig.auth?.roles);
      }
      if (rbacRoles && context.tenantConfig.auth?.roles) {
        validateConfigConsistency(rbacRoles, context.tenantConfig.auth.roles);
      }

      const timeoutMs = resolvedConfig.timeoutMs;
      const result = await runPipeline({
        tenantId: context.tenantId,
        environment: context.environment,
        trigger: 'manual',
        registry: loadOperationRegistry(context.tenantId),
        executor,
        tokenResolver,
        rbacRoles,
        tools: effectiveTools,
        modules: validatedModules,
        reasoningConfig: flags.reasoning
          ? undefined
          : { ...DEFAULT_REASONING_OPTS, enabled: false, apiKey: null },
        tracker: context.tracker,
        timeoutMs,
      });

      // Warn on degraded run (all tools failed, report has no real data)
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
        registry: getAllOperations(context.tenantId),
        timestamp: new Date().toISOString(), // determinism:allowed
      });

      const snapshotDir = safePath(resolvedConfig.snapshotDir);
      const snapshot = buildSnapshot(graphqlOps, context.tenantId, context.environment);
      await saveSnapshot(snapshot, {
        snapshotDir,
        tenantId: context.tenantId,
        environment: context.environment,
      });

      const format = resolvedConfig.format;
      const output =
        format === 'json'
          ? JSON.stringify(renderCatalogJson(catalog), null, 2)
          : renderCatalogMarkdown(catalog);
      if (!flags.quiet) {
        console.info(output);
      }

      return getScanExitCode(result);
    },
  );
}

/** Exit code from pipeline result (#572). Exported for regression tests. */
export function getScanExitCode(result: { report: { degraded?: boolean } }): number {
  return result.report.degraded ? 1 : 0;
}
