/**
 * @dino/cli — dino changelog (API changelog from schema snapshot diffs).
 * Spec: docs/CLI_SPEC.md §5.6
 */

import {
  buildSnapshot,
  saveSnapshot,
  loadLatestSnapshot,
  loadSnapshotById,
  diffSnapshots,
  generateChangelog,
  safePath,
} from '@dino/engine';
import { renderChangelogJson } from '../formatters/json';
import { renderChangelogMarkdown } from '../formatters/markdown';
import { shouldRenderInkView } from '../ink/InkRender';
import { discoverOperationsDetailed, withTracking } from '../shared/base-command';
import { emitResult } from '../shared/emit-result';
import { CliError } from '../shared/errors';
import { detectUi, createSpinner } from '../shared/ui';
import { CLI_VERSION } from '../version';
import type { CommandContext, CommonFlags } from '../shared/base-command';

export interface ChangelogFlags extends CommonFlags {
  snapshotDir?: string;
  failOnBreaking?: boolean;
  from?: string;
}

const DEFAULT_SNAPSHOT_DIR = '.dino/snapshots';

async function renderInkChangelogView(
  changelog: ReturnType<typeof generateChangelog>,
  context: CommandContext,
): Promise<void> {
  const React = await import('react');
  const { renderViewSafe } = await import('../ink/InkRender');
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
      colored: true,
    }),
  );
}

async function tryRenderInkView(
  changelog: ReturnType<typeof generateChangelog>,
  context: CommandContext,
): Promise<void> {
  try {
    await renderInkChangelogView(changelog, context);
  } catch (error_) {
    const msg = error_ instanceof Error ? error_.message : String(error_);
    console.warn('[dino] Ink changelog view failed:', msg);
  }
}

function formatChangelogOutput(
  changelog: ReturnType<typeof generateChangelog>,
  format: string,
  ui: ReturnType<typeof detectUi>,
): string {
  if (format === 'json') return renderChangelogJson(changelog);
  return renderChangelogMarkdown(changelog, ui);
}

async function loadPreviousSnapshot(
  snapshotOptions: { snapshotDir: string; tenantId: string; environment: string },
  fromId: string | undefined,
): Promise<Awaited<ReturnType<typeof loadLatestSnapshot>>> {
  if (fromId) return loadSnapshotById(snapshotOptions, fromId);
  return loadLatestSnapshot(snapshotOptions);
}

async function executeChangelog(context: CommandContext, flags: ChangelogFlags): Promise<number> {
  const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  const spinner = createSpinner('Generating changelog…', ui);
  spinner.start();

  let graphqlOps;
  let restOperations;
  try {
    const detailed = await discoverOperationsDetailed(context);
    graphqlOps = detailed.graphqlOperations;
    restOperations = detailed.discoveredOperations.filter((o) => o.type === 'rest');
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
  const currentSnapshot = buildSnapshot({
    introspection: graphqlOps,
    restOperations,
    tenantId: context.tenantId,
    environment: context.environment,
  });
  const previousSnapshot = await loadPreviousSnapshot(snapshotOptions, flags.from);

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
  // #172: --quiet strips chrome only — the changelog always goes to stdout via emitResult (#2172)
  emitResult(formatChangelogOutput(changelog, format, ui), {
    format: format === 'json' ? 'json' : 'markdown',
  });
  if (!flags.quiet && shouldRenderInkView(ui, { format, quiet: flags.quiet })) {
    await tryRenderInkView(changelog, context);
  }

  return flags.failOnBreaking && changelog.hasBreakingChanges ? 3 : 0;
}

/**
 * dino changelog --tenant circo --env qa [--fail-on-breaking] [--from <snapshotId>]
 */
export async function runChangelog(
  context: CommandContext,
  flags: ChangelogFlags,
): Promise<number> {
  return withTracking({
    context,
    command: 'changelog',
    flagsPayload: {
      tenant: flags.tenant,
      env: flags.env,
      snapshotDir: flags.snapshotDir,
      failOnBreaking: flags.failOnBreaking,
      from: flags.from,
      debug: flags.debug,
      noColor: flags.noColor,
    },
    quiet: flags.quiet,
    body: () => executeChangelog(context, flags),
  });
}
