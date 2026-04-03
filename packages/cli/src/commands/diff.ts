/**
 * @dino/cli — dino diff (schema diff vs last snapshot).
 * Spec: docs/CLI_SPEC.md §5.3
 */

import type { CommandContext, CommonFlags } from '../shared/base-command';
import { discoverOperations, withTracking } from '../shared/base-command';
import { buildSnapshot, saveSnapshot, loadLatestSnapshot, diffSnapshots } from '@intelligence';
import { safePath } from '@utils/safe-path';
import { renderDiffMarkdown } from '../formatters/markdown';
import { renderDiffJson } from '../formatters/json';

export interface DiffFlags extends CommonFlags {
  snapshotDir?: string;
  failOnBreaking?: boolean;
}

const DEFAULT_SNAPSHOT_DIR = '.dino/snapshots';

/**
 * dino diff --tenant acme --env qa [--fail-on-breaking]
 */
export async function runDiff(context: CommandContext, flags: DiffFlags): Promise<number> {
  return withTracking(
    context,
    'diff',
    {
      tenant: flags.tenant,
      env: flags.env,
      snapshotDir: flags.snapshotDir,
      failOnBreaking: flags.failOnBreaking,
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

      const currentSnapshot = buildSnapshot(graphqlOps, context.tenantId, context.environment);
      const previousSnapshot = await loadLatestSnapshot(snapshotOptions);

      if (!previousSnapshot) {
        await saveSnapshot(currentSnapshot, snapshotOptions);
        if (!flags.quiet) console.info('First snapshot saved.');
        return 0;
      }

      const diff = diffSnapshots(previousSnapshot, currentSnapshot);
      await saveSnapshot(currentSnapshot, snapshotOptions);

      const format = flags.format ?? 'markdown';
      const output = format === 'json' ? renderDiffJson(diff) : renderDiffMarkdown(diff);
      if (!flags.quiet) {
        console.info(output);
      }

      return flags.failOnBreaking && diff.summary.breakingChanges > 0 ? 1 : 0;
    },
  );
}
