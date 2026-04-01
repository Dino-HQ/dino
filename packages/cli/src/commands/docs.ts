/**
 * @dino/cli — dino docs (API reference from catalog, no pipeline).
 * Spec: docs/CLI_SPEC.md §5.2
 */

import type { CommandContext, CommonFlags } from '../shared/base-command';
import { discoverOperations, withTracking } from '../shared/base-command';
import { getAllOperations } from '@reporters/operation-mapper';
import { buildCatalog, renderCatalogMarkdown, renderCatalogJson } from '@intelligence';
import { safePath } from '@utils/safe-path';
import { safeWriteFile } from '@dino/core';

export interface DocsFlags extends CommonFlags {
  output?: string;
  title?: string;
  ai?: boolean;
  threshold?: number;
}

/**
 * dino docs --tenant acme --env qa [--format json] [--output ./docs/api.md]
 */
export async function runDocs(context: CommandContext, flags: DocsFlags): Promise<number> {
  return withTracking(
    context,
    'docs',
    {
      tenant: flags.tenant,
      env: flags.env,
      format: flags.format,
      output: flags.output,
      title: flags.title,
      ai: flags.ai,
      threshold: flags.threshold,
    },
    flags.quiet,
    async () => {
      const graphqlOps = await discoverOperations(context);

      const catalog = buildCatalog({
        introspection: graphqlOps,
        registry: getAllOperations(context.tenantId),
        timestamp: new Date().toISOString(), // determinism:allowed
      });

      const format = flags.format ?? 'markdown';
      const output =
        format === 'json'
          ? JSON.stringify(
              renderCatalogJson(catalog, {
                title: flags.title,
                includeAiDescriptions: flags.ai,
                healthScoreThreshold: flags.threshold,
              }),
              null,
              2,
            )
          : renderCatalogMarkdown(catalog, {
              title: flags.title ?? 'API Intelligence Report',
              includeAiDescriptions: flags.ai ?? false,
              healthScoreThreshold: flags.threshold,
            });

      if (flags.output) {
        const resolvedOutput = safePath(flags.output);
        await safeWriteFile(resolvedOutput, output, process.cwd());
      } else if (!flags.quiet) {
        console.info(output);
      }

      return 0;
    },
  );
}
