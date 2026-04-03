/**
 * @dino/cli — dino lint (schema description audit vs last snapshot).
 * Spec: docs/CLI_SPEC.md §5.5
 */

import type { CommandContext, CommonFlags } from '../shared/base-command';
import { discoverOperations, withTracking } from '../shared/base-command';
import { buildSnapshot, saveSnapshot, loadLatestSnapshot, auditDescriptions } from '@intelligence';
import { safePath } from '@utils/safe-path';
import { renderLintMarkdown } from '../formatters/markdown';
import { renderLintJson } from '../formatters/json';

export interface LintFlags extends CommonFlags {
  snapshotDir?: string;
  failOnUndocumented?: boolean;
}

const DEFAULT_SNAPSHOT_DIR = '.dino/snapshots';

/**
 * dino lint --tenant acme --env qa [--fail-on-undocumented]
 */
export async function runLint(context: CommandContext, flags: LintFlags): Promise<number> {
  return withTracking(
    context,
    'lint',
    {
      tenant: flags.tenant,
      env: flags.env,
      snapshotDir: flags.snapshotDir,
      failOnUndocumented: flags.failOnUndocumented,
    },
    flags.quiet,
    async () => {
      const graphqlOps = await discoverOperations(context);

      const snapshotDir = flags.snapshotDir ? safePath(flags.snapshotDir) : DEFAULT_SNAPSHOT_DIR;
      const snapshotOptions = {
        snapshotDir,
        tenantId: context.tenantId,
        environment: context.environment,
      };

      const previousSnapshot = await loadLatestSnapshot(snapshotOptions);
      const audit = auditDescriptions(graphqlOps, previousSnapshot);

      const currentSnapshot = buildSnapshot(graphqlOps, context.tenantId, context.environment);
      await saveSnapshot(currentSnapshot, snapshotOptions);

      const format = flags.format ?? 'markdown';
      const output = format === 'json' ? renderLintJson(audit) : renderLintMarkdown(audit);
      if (!flags.quiet) console.info(output);

      const regressions = audit.newUndocumented.length + audit.descriptionRemoved.length;
      return flags.failOnUndocumented && regressions > 0 ? 1 : 0;
    },
  );
}
