/**
 * DinoResult → shareable PR summary (#2191, T2 pure; Cleanup V2 task 4c reads the canonical result).
 * INV-1: failure/partial/zero-op sections carry no CLEAN/Healthy/pass badge or health-score.
 */

import { findingMass } from './finding-mass';
import { checkNoSecretLeak } from './output-contract';
import type { DinoResult } from '@dino/core';

export interface ScanSummaryInput {
  label: string;
  authed: boolean;
  credentialPresent: boolean;
  exitCode: number;
  result: DinoResult | null;
  fullReportArtifact?: string | undefined;
}

export interface PrCommentInput {
  sections: ScanSummaryInput[];
  commitSha: string;
  runUrl: string;
}

export const PR_COMMENT_MARKER = '<!-- dino-live-scan -->';
export const PR_COMMENT_MAX = 65_536;

const TRUNCATION_NOTICE =
  '\n\n_(Report truncated - see workflow artifacts for full markdown reports.)_';

function isPartialSection(result: DinoResult): boolean {
  return result.verdict.coverage === 'partial';
}

/** The declared partial exit (6) carries a valid result; every other non-zero exit is a failure. */
const PARTIAL_EXIT_CODE = 6;

function isFailureSection(input: ScanSummaryInput): boolean {
  if (input.result === null) return true;
  if (input.exitCode === 0) return false;
  return !(input.exitCode === PARTIAL_EXIT_CODE && isPartialSection(input.result));
}

function isZeroOpsSection(result: DinoResult): boolean {
  return result.verdict.operationCount === 0;
}

function operationsLine(result: DinoResult): string {
  return `Operations: ${result.verdict.operationCount ?? 'unknown'}`;
}

function appendArtifactLine(lines: string[], artifact: string | undefined): void {
  if (artifact !== undefined) {
    lines.push(`Full report artifact: \`${artifact}\``);
  }
}

function renderFailureSection(input: ScanSummaryInput): string {
  const lines = [`### ${input.label}`, `Scan failed (exit ${input.exitCode})`];
  if (input.result === null) {
    lines.push('No valid DinoResult was produced.');
  }
  appendArtifactLine(lines, input.fullReportArtifact);
  return lines.join('\n');
}

function renderPartialSection(input: ScanSummaryInput, result: DinoResult): string {
  const lines = [`### ${input.label}`, 'Partial coverage: verification was incomplete.'];
  if (result.verdict.reasons.length > 0) {
    lines.push(`Reason: ${result.verdict.reasons.join(', ')}`);
  }
  lines.push(operationsLine(result));
  appendArtifactLine(lines, input.fullReportArtifact);
  return lines.join('\n');
}

function renderZeroOpsSection(input: ScanSummaryInput): string {
  const lines = [`### ${input.label}`, '0 operations discovered.'];
  appendArtifactLine(lines, input.fullReportArtifact);
  return lines.join('\n');
}

function renderSuccessSection(input: ScanSummaryInput, result: DinoResult): string {
  const lines = [
    `### ${input.label}`,
    operationsLine(result),
    `Health verdict: ${result.verdict.health.verdict}`,
  ];
  if (result.verdict.health.score !== null) {
    lines.push(`Health score: ${result.verdict.health.score}/100`);
  }
  lines.push(`Findings: ${findingMass(result.findings)}`);
  appendArtifactLine(lines, input.fullReportArtifact);
  return lines.join('\n');
}

/** Renders one scan section. INV-1/4: honest failure, partial, zero-op, or skip lines. */
export function buildScanSummarySection(input: ScanSummaryInput): string {
  if (input.authed && !input.credentialPresent) {
    return [`### ${input.label}`, 'skipped - no credential'].join('\n');
  }
  if (isFailureSection(input)) {
    return renderFailureSection(input);
  }
  const result = input.result;
  if (result === null) {
    return [`### ${input.label}`, 'Scan failed - no result.'].join('\n');
  }
  if (isPartialSection(result)) {
    return renderPartialSection(input, result);
  }
  if (isZeroOpsSection(result)) {
    return renderZeroOpsSection(input);
  }
  return renderSuccessSection(input, result);
}

function buildHeader(input: PrCommentInput): string {
  return [
    PR_COMMENT_MARKER,
    '## Dino Live Scan',
    '',
    `Commit: \`${input.commitSha}\``,
    `[Workflow run](${input.runUrl})`,
    '',
  ].join('\n');
}

function truncateToMax(body: string, input: PrCommentInput): string {
  if (body.length <= PR_COMMENT_MAX) return body;
  const header = buildHeader(input);
  const budget = PR_COMMENT_MAX - header.length - TRUNCATION_NOTICE.length;
  const sections = input.sections.map((s) => buildScanSummarySection(s));
  let assembled = header;
  for (const section of sections) {
    const next = `${assembled}${section}\n\n`;
    if (next.length > budget) {
      assembled = `${header}${section.slice(0, Math.max(0, budget - header.length))}${TRUNCATION_NOTICE}`;
      return assembled.slice(0, PR_COMMENT_MAX);
    }
    assembled = next;
  }
  return `${assembled}${TRUNCATION_NOTICE}`.slice(0, PR_COMMENT_MAX);
}

/** Assembles the sticky PR comment. INV-2/5. */
export function buildPrComment(input: PrCommentInput): string {
  const header = buildHeader(input);
  const sections = input.sections.map((s) => buildScanSummarySection(s)).join('\n\n');
  const body = `${header}${sections}\n`;
  return truncateToMax(body, input);
}

/**
 * INV-3: checkNoSecretLeak(text, text) on body + each artifact (Bearer scans 2nd arg).
 */
export function assertOutputClean(
  body: string,
  artifacts: string[],
): { ok: boolean; reason?: string } {
  for (const text of [body, ...artifacts]) {
    const check = checkNoSecretLeak(text, text);
    if (!check.ok) {
      return { ok: false, reason: check.error ?? 'secret leak detected' };
    }
  }
  return { ok: true };
}
