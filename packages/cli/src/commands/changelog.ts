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
import { detectUi, createSpinner } from '../shared/ui';
import { shouldRenderInkView } from '../ink/render';
import { CLI_VERSION } from '../version';

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
      debug: flags.debug,
      noColor: flags.noColor,
    },
    flags.quiet,
    async () => {
      const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
      const spinner = createSpinner('Generating changelog…', ui);
      spinner.start();
      let graphqlOps;
      try {
        graphqlOps = await discoverOperations(context);
        spinner.text = 'Loading snapshots…';
      } catch (err) {
        spinner.fail('Changelog failed');
        throw err;
      }

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
        spinner.succeed('First snapshot saved');
        return 0;
      }

      const diff = diffSnapshots(previousSnapshot, currentSnapshot);
      const changelog = generateChangelog(diff);
      await saveSnapshot(currentSnapshot, snapshotOptions);

      spinner.succeed('Changelog generated');

      const format = flags.format ?? 'markdown';
      const markdownUi = format === 'json' ? undefined : ui;
      const output =
        format === 'json'
          ? renderChangelogJson(changelog)
          : renderChangelogMarkdown(changelog, markdownUi);
      if (!flags.quiet) console.info(output);

      if (!flags.quiet && shouldRenderInkView(ui, { format, quiet: flags.quiet })) {
        try {
          const React = await import('react');
          const { renderViewSafe } = await import('../ink/render');
          const { ChangelogView } = await import('../views/ChangelogView');
          const modifiedCount = changelog.summary.changed + changelog.summary.deprecated;
          renderViewSafe(
            React.createElement(ChangelogView, {
              version: CLI_VERSION,
              tenant: context.tenantId,
              environment: context.environment,
              fromId: changelog.fromSnapshotId,
              toId: changelog.toSnapshotId,
              added: changelog.summary.added,
              removed: changelog.summary.removed,
              modified: modifiedCount,
              breakingCount: changelog.summary.breaking,
              colored: ui.colored,
            }),
          );
        } catch (inkErr) {
          console.warn(
            '[dino] Ink changelog view failed:',
            inkErr instanceof Error ? inkErr.message : String(inkErr),
          );
        }
      }

      return flags.failOnBreaking && changelog.hasBreakingChanges ? 1 : 0;
    },
  );
}
