/**
 * Coverage Gap prompt — strategy-specific instructions for coverage gap analysis.
 *
 * Extends the base prompt via composeSystemPrompt(base, thisInstructions).
 * Decision #12: strategies compose, never write from scratch.
 */

import type { PromptReportInput } from './_shared';
import { wrapInCodeFence } from './_shared';

/**
 * Returns strategy-specific instructions for the Coverage Gap Analysis strategy.
 * This gets passed as the second argument to composeSystemPrompt(base, instructions).
 */
export function buildCoverageGapPromptInstructions(): string {
  return [
    'You are analyzing test coverage data from automated QA tools.',
    'The data includes test-scaffolder results (what operations exist) and response-validator results (what was actually tested).',
    '',
    'Your task:',
    '1. Identify coverage gaps: operations that are untested, partially tested, stale, or only showing errors.',
    '   - UNTESTED: Operation appears in scaffolded tests but has no validation results',
    '   - PARTIAL: Some tests pass but critical paths (error handling, edge cases) are missing',
    '   - STALE: Tests exist but recent findings show schema drift or consistent failures',
    '   - ERROR_ONLY: Only execution errors observed — no successful validation ever recorded',
    '2. Assess an overall coverage score (0-100) based on the ratio of well-tested operations to total operations.',
    '3. Produce a prioritized testing roadmap: what to test next, ranked by risk impact.',
    '',
    'Prioritization guide:',
    '- CRITICAL operations (payments, auth, user data) with gaps should be highest priority',
    '- Operations with SCHEMA_MISMATCH or EXECUTION_ERROR findings indicate active breakage — high priority',
    '- CLEAN operations with full pass rates need no action',
    '- Group related operations (e.g., all payment mutations) into single roadmap items when practical',
    '',
    'Focus on actionable gaps. Do not list operations that are fully covered and passing.',
    'If the data is insufficient to determine coverage for some operations, note them as UNTESTED.',
  ].join('\n');
}

/**
 * Serializes the relevant parts of a CondensedReport into a user prompt string.
 * Includes ALL envelopes (not filtered by tool) — coverage analysis needs the full picture.
 */
export function buildCoverageGapUserPrompt(report: PromptReportInput): string {
  const input = {
    runId: report.runId,
    environment: report.environment,
    aggregate: report.aggregate,
    toolResults: report.envelopes,
    truncated: report.truncated,
  };

  return wrapInCodeFence(
    'Analyze the following test coverage data and produce a coverage gap analysis with a prioritized testing roadmap.',
    JSON.stringify(input, null, 2),
  );
}
