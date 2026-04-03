/**
 * @dino/cli — Diff and lint output as markdown (terminal-friendly)
 *
 * Local DiffSummary type mirrors SnapshotDiff shape from intelligence layer.
 */

import type { DescriptionAuditResult, ChangelogResult } from '@intelligence';

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

/**
 * Render a diff summary as human-readable markdown for terminal output.
 */
export function renderDiffMarkdown(diff: DiffSummary): string {
  const lines: string[] = [
    '## Schema diff summary',
    '',
    `**Previous:** ${diff.previousSnapshotId} → **Current:** ${diff.currentSnapshotId}`,
    `**Time delta:** ${Math.round(diff.timeDeltaMs / 1000)}s`,
    '',
    `- Added: ${diff.summary.added}`,
    `- Removed: ${diff.summary.removed}`,
    `- Modified: ${diff.summary.modified}`,
    `- Unchanged: ${diff.summary.unchanged}`,
    `- Breaking changes: ${diff.summary.breakingChanges}`,
    '',
  ];

  if (diff.summary.breakingChanges > 0) {
    lines.push(
      '### Breaking changes',
      '',
      'Schema has breaking changes (removed or modified operations).',
      '',
    );
  }

  if (diff.added.length > 0) {
    lines.push('### Added operations', '');
    for (const name of diff.added) {
      lines.push(`- ${name}`);
    }
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push('### Removed operations', '');
    for (const name of diff.removed) {
      lines.push(`- ${name}`);
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

  return lines.join('\n');
}

/**
 * Render a description audit result as human-readable markdown.
 */
export function renderLintMarkdown(audit: DescriptionAuditResult): string {
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

  if (audit.descriptionAdded.length > 0) {
    lines.push(`### Descriptions added (${audit.descriptionAdded.length})`, '');
    for (const name of audit.descriptionAdded) lines.push(`- ${name}`);
    lines.push('');
  }

  if (audit.newUndocumented.length > 0) {
    lines.push(
      `### New undocumented operations (${audit.newUndocumented.length})`,
      '',
      'These operations were added without a description:',
      '',
    );
    for (const name of audit.newUndocumented) lines.push(`- ${name}`);
    lines.push('');
  }

  if (audit.descriptionRemoved.length > 0) {
    lines.push(
      `### Descriptions removed (${audit.descriptionRemoved.length})`,
      '',
      'These operations had descriptions that were removed:',
      '',
    );
    for (const name of audit.descriptionRemoved) lines.push(`- ${name}`);
    lines.push('');
  }

  const regressions = audit.newUndocumented.length + audit.descriptionRemoved.length;
  if (regressions > 0) {
    lines.push(`Result: FAIL — ${regressions} regression${regressions === 1 ? '' : 's'} found`, '');
  } else {
    lines.push('Result: PASS — no description regressions', '');
  }

  return lines.join('\n');
}

/**
 * Render a changelog result as human-readable markdown (Keep a Changelog style).
 */
export function renderChangelogMarkdown(changelog: ChangelogResult): string {
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
  if (breakingEntries.length > 0) {
    lines.push(`### Breaking Changes (${breakingEntries.length})`, '');
    for (const e of breakingEntries) {
      lines.push(`- **${e.operation}** — ${e.description}`);
      if (e.migration) lines.push(`  > Migration: ${e.migration}`);
    }
    lines.push('');
  }

  const categories: Array<ChangelogResult['entries'][0]['category']> = [
    'added',
    'changed',
    'deprecated',
    'removed',
  ];
  for (const cat of categories) {
    const entries = changelog.entries.filter((e) => e.category === cat);
    if (entries.length === 0) continue;
    const title = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`### ${title} (${entries.length})`, '');
    for (const e of entries) {
      lines.push(`- **${e.operation}** — ${e.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
