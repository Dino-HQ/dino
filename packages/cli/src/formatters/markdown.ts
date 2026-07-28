/**
 * @dino/cli — Diff and lint output as markdown (terminal-friendly)
 *
 * Local DiffSummary type mirrors SnapshotDiff shape from intelligence layer.
 */

import chalk from 'chalk';
import type { UiOptions } from '../shared/ui';
import type { DescriptionAuditResult, ChangelogResult } from '@dino/engine';

/** Local type mirroring the shape from SnapshotDiff that formatters consume */
export interface DiffSummary {
  previousSnapshotId: string;
  currentSnapshotId: string;
  timeDeltaMs: number;
  added: string[];
  removed: string[];
  modified: Array<{
    name: string;
    changes: Array<{ field: string; previous: string; current: string }>;
  }>;
  summary: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
    breakingChanges: number;
  };
}

function maybeColor(applyColor: boolean, fn: (s: string) => string, text: string): string {
  if (applyColor) {
    return fn(text);
  }
  return text;
}

function pushDiffOperationLists(lines: string[], diff: DiffSummary, applyColor: boolean): void {
  if (diff.added.length > 0) {
    lines.push('### Added operations', '');
    for (const name of diff.added) {
      lines.push(`- ${maybeColor(applyColor, chalk.green, name)}`);
    }
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push('### Removed operations', '');
    for (const name of diff.removed) {
      lines.push(`- ${maybeColor(applyColor, chalk.red, name)}`);
    }
    lines.push('');
  }

  if (diff.modified.length > 0) {
    lines.push('### Modified operations', '');
    for (const op of diff.modified) {
      lines.push(`- **${op.name}**`);
      for (const change of op.changes) {
        lines.push(`  - ${change.field}: \`${change.previous}\` → \`${change.current}\``);
      }
      lines.push('');
    }
  }
}

/**
 * Render a diff summary as human-readable markdown for terminal output.
 */
export function renderDiffMarkdown(diff: DiffSummary, ui?: UiOptions): string {
  const applyColor = ui?.colored ?? false;
  const bc = diff.summary.breakingChanges;
  const breakingPart = bc > 0 && applyColor ? chalk.red.bold(String(bc)) : String(bc);

  const lines: string[] = [
    '## Schema diff summary',
    '',
    `**Previous:** ${diff.previousSnapshotId} → **Current:** ${diff.currentSnapshotId}`,
    `**Time delta:** ${Math.round(diff.timeDeltaMs / 1000)}s`,
    '',
    `- Added: ${maybeColor(applyColor, chalk.green, String(diff.summary.added))}`,
    `- Removed: ${maybeColor(applyColor, chalk.red, String(diff.summary.removed))}`,
    `- Modified: ${maybeColor(applyColor, chalk.yellow, String(diff.summary.modified))}`,
    `- Unchanged: ${maybeColor(applyColor, chalk.dim, String(diff.summary.unchanged))}`,
    `- Breaking changes: ${breakingPart}`,
    '',
  ];

  if (bc > 0) {
    lines.push(
      '### Breaking changes',
      '',
      'Schema has breaking changes (removed or modified operations).',
      '',
    );
  }

  pushDiffOperationLists(lines, diff, applyColor);
  return lines.join('\n');
}

function appendLintDescriptionAdded(
  lines: string[],
  audit: DescriptionAuditResult,
  applyColor: boolean,
): void {
  if (audit.descriptionAdded.length === 0) {
    return;
  }
  const heading = `### Descriptions added (${audit.descriptionAdded.length})`;
  lines.push(maybeColor(applyColor, chalk.green, heading), '');
  for (const name of audit.descriptionAdded) {
    lines.push(`- ${maybeColor(applyColor, chalk.green, name)}`);
  }
  lines.push('');
}

function appendLintNewUndocumented(
  lines: string[],
  audit: DescriptionAuditResult,
  applyColor: boolean,
): void {
  if (audit.newUndocumented.length === 0) {
    return;
  }
  const heading = `### New undocumented operations (${audit.newUndocumented.length})`;
  lines.push(
    maybeColor(applyColor, chalk.red, heading),
    '',
    'These operations were added without a description:',
    '',
  );
  for (const name of audit.newUndocumented) {
    lines.push(`- ${maybeColor(applyColor, chalk.red, name)}`);
  }
  lines.push('');
}

function appendLintDescriptionRemoved(
  lines: string[],
  audit: DescriptionAuditResult,
  applyColor: boolean,
): void {
  if (audit.descriptionRemoved.length === 0) {
    return;
  }
  const heading = `### Descriptions removed (${audit.descriptionRemoved.length})`;
  lines.push(
    maybeColor(applyColor, chalk.red, heading),
    '',
    'These operations had descriptions that were removed:',
    '',
  );
  for (const name of audit.descriptionRemoved) {
    lines.push(`- ${maybeColor(applyColor, chalk.red, name)}`);
  }
  lines.push('');
}

/**
 * Render a description audit result as human-readable markdown.
 */
export function renderLintMarkdown(audit: DescriptionAuditResult, ui?: UiOptions): string {
  const applyColor = ui?.colored ?? false;
  const lines: string[] = [
    '## Schema description audit',
    '',
    `- Total operations: ${audit.totalOperations}`,
    `- Documented: ${audit.totalOperations - audit.totalUndocumented} (${audit.coveragePercent}%)`,
    `- Undocumented: ${audit.totalUndocumented} (${(100 - audit.coveragePercent).toFixed(1)}%)`,
    '',
  ];

  if (audit.firstRun) {
    lines.push('First run — baseline snapshot saved. No regressions to compare against.', '');
    return lines.join('\n');
  }

  appendLintDescriptionAdded(lines, audit, applyColor);
  appendLintNewUndocumented(lines, audit, applyColor);
  appendLintDescriptionRemoved(lines, audit, applyColor);

  const regressions = audit.newUndocumented.length + audit.descriptionRemoved.length;
  if (regressions > 0) {
    const suffix = regressions === 1 ? '' : 's';
    const failLine = `Result: FAIL — ${regressions} regression${suffix} found`;
    lines.push(maybeColor(applyColor, chalk.red, failLine), '');
  } else {
    const passLine = 'Result: PASS — no description regressions';
    lines.push(maybeColor(applyColor, chalk.green, passLine), '');
  }

  return lines.join('\n');
}

function appendChangelogBreaking(
  lines: string[],
  breakingEntries: ChangelogResult['entries'],
  applyColor: boolean,
): void {
  if (breakingEntries.length === 0) {
    return;
  }
  const title = `### Breaking Changes (${breakingEntries.length})`;
  const titleOut = maybeColor(applyColor, (s) => chalk.red.bold(s), title);
  lines.push(titleOut, '');
  for (const e of breakingEntries) {
    const opLine = `- **${e.operation}** — ${e.description}`;
    lines.push(maybeColor(applyColor, chalk.red, opLine));
    if (e.migration) {
      const mig = `  > Migration: ${e.migration}`;
      lines.push(maybeColor(applyColor, chalk.red, mig));
    }
  }
  lines.push('');
}

function appendChangelogCategorySections(
  lines: string[],
  changelog: ChangelogResult,
  applyColor: boolean,
): void {
  const categories: Array<ChangelogResult['entries'][0]['category']> = [
    'added',
    'changed',
    'deprecated',
    'removed',
  ];
  for (const cat of categories) {
    const entries = changelog.entries.filter((e) => e.category === cat);
    if (entries.length === 0) {
      continue;
    }
    const titleWord = cat.charAt(0).toUpperCase() + cat.slice(1);
    const sectionTitle = `### ${titleWord} (${entries.length})`;
    const isAdded = cat === 'added';
    const sectionOut = isAdded && applyColor ? chalk.green(sectionTitle) : sectionTitle;
    lines.push(sectionOut, '');
    for (const e of entries) {
      const entryLine = `- **${e.operation}** — ${e.description}`;
      const lineOut = isAdded && applyColor ? chalk.green(entryLine) : entryLine;
      lines.push(lineOut);
    }
    lines.push('');
  }
}

/**
 * Render a changelog result as human-readable markdown (Keep a Changelog style).
 */
export function renderChangelogMarkdown(changelog: ChangelogResult, ui?: UiOptions): string {
  const applyColor = ui?.colored ?? false;
  const lines: string[] = [
    '## API Changelog',
    '',
    `**From:** ${changelog.fromSnapshotId} → **To:** ${changelog.toSnapshotId} · **Generated:** ${changelog.timestamp}`,
    '',
  ];

  if (changelog.entries.length === 0) {
    lines.push('No API changes detected.', '');
    return lines.join('\n');
  }

  const breakingEntries = changelog.entries.filter((e) => e.migration != null);
  appendChangelogBreaking(lines, breakingEntries, applyColor);
  appendChangelogCategorySections(lines, changelog, applyColor);

  return lines.join('\n');
}
