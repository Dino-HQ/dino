/**
 * @dino/cli — dino diff (schema diff vs last snapshot).
 * Spec: docs/CLI_SPEC.md §5.3
 */

import {
  buildSnapshot,
  saveSnapshot,
  loadLatestSnapshot,
  diffSnapshots,
  safePath,
} from '@dino/engine';
import { renderDiffJson } from '../formatters/json';
import { renderDiffMarkdown } from '../formatters/markdown';
import { shouldRenderInkView } from '../ink/InkRender';
import { discoverOperations, withTracking } from '../shared/base-command';
import { detectUi, createSpinner, colorize } from '../shared/ui';
import { CLI_VERSION } from '../version';
import type { CommandContext, CommonFlags } from '../shared/base-command';
import type { UiOptions } from '../shared/ui';

export interface DiffFlags extends CommonFlags {
  snapshotDir?: string;
  failOnBreaking?: boolean;
}

const DEFAULT_SNAPSHOT_DIR = '.dino/snapshots';

async function showDiffFooter(
  ui: UiOptions,
  diff: {
    timeDeltaMs: number;
    summary: { added: number; removed: number; modified: number; breakingChanges: number };
  },
  context: { tenantId: string; environment: string },
): Promise<boolean> {
  try {
    const React = await import('react');
    const { renderViewSafe } = await import('../ink/InkRender');
    const { DiffView } = await import('../views/DiffView');
    const td = diff.timeDeltaMs;
    let timeLabel: string;
    if (!Number.isFinite(td)) {
      timeLabel = 'Time delta: N/A';
    } else if (td >= 1000) {
      timeLabel = `Time delta: ${(td / 1000).toFixed(1)}s`;
    } else {
      timeLabel = `Time delta: ${Math.round(td)}ms`;
    }
    return renderViewSafe(
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
  } catch (error_) {
    console.warn(
      '[dino] Ink diff view failed:',
      error_ instanceof Error ? error_.message : String(error_),
    );
    return false;
  }
}

async function executeDiffBody(context: CommandContext, flags: DiffFlags): Promise<number> {
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

  const currentSnapshot = buildSnapshot({
    introspection: graphqlOps,
    tenantId: context.tenantId,
    environment: context.environment,
  });
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
  const output = format === 'json' ? renderDiffJson(diff) : renderDiffMarkdown(diff, markdownUi);
  if (!flags.quiet) {
    console.info(output);
  }

  let inkFooter = false;
  if (
    !flags.quiet &&
    format !== 'json' &&
    shouldRenderInkView(ui, { format, quiet: flags.quiet })
  ) {
    inkFooter = await showDiffFooter(ui, diff, context);
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
}

/**
 * dino diff --tenant acme --env qa [--fail-on-breaking]
 */
export async function runDiff(context: CommandContext, flags: DiffFlags): Promise<number> {
  return withTracking({
    context,
    command: 'diff',
    flagsPayload: {
      tenant: flags.tenant,
      env: flags.env,
      snapshotDir: flags.snapshotDir,
      failOnBreaking: flags.failOnBreaking,
      debug: flags.debug,
      noColor: flags.noColor,
    },
    quiet: flags.quiet,
    body: () => executeDiffBody(context, flags),
  });
}
