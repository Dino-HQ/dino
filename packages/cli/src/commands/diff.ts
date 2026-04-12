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
import { detectUi, createSpinner, colorize } from '../shared/ui';
import { shouldRenderInkView } from '../ink/render';
import { CLI_VERSION } from '../version';

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
      debug: flags.debug,
      noColor: flags.noColor,
    },
    flags.quiet,
    async () => {
      const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
      const spinner = createSpinner('Comparing snapshots…', ui);
      spinner.start();
      let graphqlOps;
      try {
        graphqlOps = await discoverOperations(context);
        spinner.text = 'Loading snapshots…';
      } catch (err) {
        spinner.fail('Diff failed');
        throw err;
      }

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
        spinner.succeed('First snapshot saved');
        return 0;
      }

      const diff = diffSnapshots(previousSnapshot, currentSnapshot);
      await saveSnapshot(currentSnapshot, snapshotOptions);

      spinner.succeed('Diff complete');

      const format = flags.format ?? 'markdown';
      const markdownUi = format === 'json' ? undefined : ui;
      const output =
        format === 'json' ? renderDiffJson(diff) : renderDiffMarkdown(diff, markdownUi);
      if (!flags.quiet) {
        console.info(output);
      }

      let inkFooter = false;
      if (
        !flags.quiet &&
        format !== 'json' &&
        shouldRenderInkView(ui, { format, quiet: flags.quiet })
      ) {
        try {
          const React = await import('react');
          const { renderViewSafe } = await import('../ink/render');
          const { DiffView } = await import('../views/DiffView');
          const td = diff.timeDeltaMs;
          const timeLabel = !Number.isFinite(td)
            ? 'Time delta: N/A'
            : td >= 1000
              ? `Time delta: ${(td / 1000).toFixed(1)}s`
              : `Time delta: ${Math.round(td)}ms`;
          inkFooter = renderViewSafe(
            React.createElement(DiffView, {
              version: CLI_VERSION,
              tenant: context.tenantId,
              environment: context.environment,
              added: diff.summary.added,
              removed: diff.summary.removed,
              modified: diff.summary.modified,
              breakingChanges: diff.summary.breakingChanges,
              timeDeltaLabel: timeLabel,
              colored: ui.colored,
            }),
          );
        } catch (inkErr) {
          console.warn(
            '[dino] Ink diff view failed:',
            inkErr instanceof Error ? inkErr.message : String(inkErr),
          );
          inkFooter = false;
        }
      }
      if (!flags.quiet && format !== 'json' && !inkFooter) {
        console.info(
          colorize(
            'Next: run dino watch --autonomy enforce to block breaking changes in CI.',
            'dim',
            ui,
          ),
        );
      }

      return flags.failOnBreaking && diff.summary.breakingChanges > 0 ? 1 : 0;
    },
  );
}
