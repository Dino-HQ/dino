/**
 * @dino/cli — dino changelog (API changelog from schema snapshot diffs).
 * Spec: docs/CLI_SPEC.md §5.6
 */

import type { CommandContext, CommonFlags } from '../shared/base-command';
import { discoverOperations, withTracking } from '../shared/base-command';
import {
  buildSnapshot,
  saveSnapshot,
  loadLatestSnapshot,
  loadSnapshotById,
  diffSnapshots,
  generateChangelog,
} from '@intelligence';
import { safePath } from '@utils/safe-path';
import { renderChangelogMarkdown } from '../formatters/markdown';
import { renderChangelogJson } from '../formatters/json';
import { CliError } from '../shared/errors';

export interface ChangelogFlags extends CommonFlags {
  snapshotDir?: string;
  failOnBreaking?: boolean;
  from?: string;
}

const DEFAULT_SNAPSHOT_DIR = '.dino/snapshots';

/**
 * dino changelog --tenant circo --env qa [--fail-on-breaking] [--from <snapshotId>]
 */
export async function runChangelog(
  context: CommandContext,
  flags: ChangelogFlags,
): Promise<number> {
  return withTracking(
    context,
    'changelog',
    {
      tenant: flags.tenant,
      env: flags.env,
      snapshotDir: flags.snapshotDir,
      failOnBreaking: flags.failOnBreaking,
      from: flags.from,
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

      const previousSnapshot = flags.from
        ? await loadSnapshotById(snapshotOptions, flags.from)
        : await loadLatestSnapshot(snapshotOptions);

      if (flags.from && previousSnapshot === null) {
        throw new CliError(`Snapshot not found: ${flags.from}`);
      }

      if (!previousSnapshot) {
        await saveSnapshot(currentSnapshot, snapshotOptions);
        if (!flags.quiet) console.info('First snapshot saved.');
        return 0;
      }

      const diff = diffSnapshots(previousSnapshot, currentSnapshot);
      const changelog = generateChangelog(diff);
      await saveSnapshot(currentSnapshot, snapshotOptions);

      const format = flags.format ?? 'markdown';
      const output =
        format === 'json' ? renderChangelogJson(changelog) : renderChangelogMarkdown(changelog);
      if (!flags.quiet) console.info(output);

      return flags.failOnBreaking && changelog.hasBreakingChanges ? 1 : 0;
    },
  );
}
