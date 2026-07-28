/**
 * @dino/cli — Diff and lint output as JSON
 */

import type { DiffSummary } from './markdown';
import type { DescriptionAuditResult, ChangelogResult } from '@dino/engine';

/**
 * Render a diff summary as machine-readable JSON.
 */
export function renderDiffJson(diff: DiffSummary): string {
  return JSON.stringify(diff, null, 2);
}

/**
 * Render a description audit result as machine-readable JSON.
 */
export function renderLintJson(audit: DescriptionAuditResult): string {
  return JSON.stringify(audit, null, 2);
}

/**
 * Render a changelog result as machine-readable JSON.
 */
export function renderChangelogJson(changelog: ChangelogResult): string {
  return JSON.stringify(changelog, null, 2);
}
