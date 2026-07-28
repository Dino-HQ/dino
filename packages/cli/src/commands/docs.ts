/**
 * @dino/cli — dino docs (API reference from catalog, no pipeline).
 * Spec: docs/CLI_SPEC.md §5.2
 */

import { safeWriteFile } from '@dino/core';
import {
  getAllOperations,
  hasOperationsFile,
  buildCatalog,
  renderCatalogMarkdown,
  renderCatalogJson,
  safePath,
} from '@dino/engine';
import { buildAdHocOperationMappings } from './scan-helpers';
import { discoverOperations, withTracking } from '../shared/base-command';
import { detectUi, createSpinner } from '../shared/ui';
import type { CommandContext, CommonFlags } from '../shared/base-command';

export interface DocsFlags extends CommonFlags {
  output?: string;
  title?: string;
  ai?: boolean;
  threshold?: number;
}

function formatCatalogOutput(catalog: ReturnType<typeof buildCatalog>, flags: DocsFlags): string {
  const format = flags.format ?? 'markdown';
  if (format === 'json') {
    return JSON.stringify(
      renderCatalogJson(catalog, {
        title: flags.title,
        includeAiDescriptions: flags.ai,
        healthScoreThreshold: flags.threshold,
      }),
      null,
      2,
    );
  }
  return renderCatalogMarkdown(catalog, {
    title: flags.title ?? 'API Intelligence Report',
    includeAiDescriptions: flags.ai ?? false,
    healthScoreThreshold: flags.threshold,
  });
}

async function executeDocsBody(context: CommandContext, flags: DocsFlags): Promise<number> {
  const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  const spinner = createSpinner('Generating documentation…', ui);
  spinner.start();
  let graphqlOps;
  try {
    graphqlOps = await discoverOperations(context);
    spinner.text = 'Building documentation…';
  } catch (err) {
    spinner.fail('Docs failed');
    throw err;
  }

  // #1986 — mirror scan-pipeline's ad-hoc fallback. `docs` unconditionally read the tenant
  // operations file, so an ad-hoc run (tenant `adhoc`, registry built from live introspection —
  // there is no such file) died with "Tenant operations file not found: …/adhoc-operations.json".
  // Found by runtime verification: `dino scan` worked while `dino docs` still failed.
  const useAdHocFallback = context.tenantId === 'adhoc' || !hasOperationsFile(context.tenantId);
  const catalog = buildCatalog({
    introspection: graphqlOps,
    registry: useAdHocFallback
      ? buildAdHocOperationMappings(graphqlOps, context.tenantId)
      : getAllOperations(context.tenantId),
    timestamp: new Date().toISOString(), // determinism:allowed
  });

  const output = formatCatalogOutput(catalog, flags);
  spinner.succeed('Docs generated');

  if (flags.output) {
    const resolvedOutput = safePath(flags.output);
    await safeWriteFile(resolvedOutput, output, process.cwd());
  } else if (!flags.quiet) {
    console.info(output);
  }

  return 0;
}

/**
 * dino docs --tenant acme --env qa [--format json] [--output ./docs/api.md]
 */
export async function runDocs(context: CommandContext, flags: DocsFlags): Promise<number> {
  return withTracking({
    context,
    command: 'docs',
    flagsPayload: {
      tenant: flags.tenant,
      env: flags.env,
      format: flags.format,
      output: flags.output,
      title: flags.title,
      ai: flags.ai,
      threshold: flags.threshold,
      debug: flags.debug,
      noColor: flags.noColor,
    },
    quiet: flags.quiet,
    body: () => executeDocsBody(context, flags),
  });
}
