/**
 * Cross-Agent prompt — strategy-specific instructions for cross-tool correlation analysis.
 *
 * Extends the base prompt via composeSystemPrompt(base, thisInstructions).
 * Decision #12: strategies compose, never write from scratch.
 */

import type { PromptReportInput } from './_shared';
import { wrapInCodeFence } from './_shared';

/**
 * Returns strategy-specific instructions for the Cross-Agent Correlation strategy.
 * This gets passed as the second argument to composeSystemPrompt(base, instructions).
 */
export function buildCrossAgentPromptInstructions(): string {
  return [
    'You are analyzing test results from MULTIPLE automated QA tools run against the same API.',
    'Each tool tests a different dimension: response validation, input fuzzing, test scaffolding, etc.',
    '',
    'Your task is to find CROSS-TOOL CORRELATIONS — patterns that only emerge when combining results from different tools.',
    '',
    'What to look for:',
    '1. Security compound risks: An operation that fails auth checks (response-validator) AND accepts malformed input (input-fuzzer) is worse than either finding alone.',
    '2. Schema-fuzz overlaps: Operations with SCHEMA_MISMATCH findings AND fuzzing anomalies suggest unstable endpoints.',
    '3. Coverage blind spots: Operations that appear in scaffolding but have no validation or fuzzing results.',
    '4. Error clustering: Multiple tools reporting errors on the same operation suggests a systemic issue.',
    '5. Severity escalation: A MEDIUM finding from one tool + a MEDIUM from another on the same operation may warrant HIGH overall.',
    '',
    'Correlation rules:',
    '- Each correlation MUST involve findings from at least 2 different tools.',
    '- Assign severity based on the COMBINED impact, not the individual finding severities. This is a correlation-level severity only — it does NOT override the deterministic envelope or report severity scores.',
    '- The id field should be a short kebab-case identifier (e.g., "unprotected-wallet-endpoint").',
    '- toolsInvolved lists the tool names contributing to this correlation.',
    '- findings array contains the specific evidence from each tool.',
    '',
    'Blind spots:',
    '- Identify areas where tool coverage gaps create unknown risk.',
    '- Example: "Payment mutations were fuzzed but never schema-validated — contract compliance is unknown."',
    '',
    'If there are no meaningful cross-tool correlations, return an empty correlations array with overallRisk: "NONE".',
    'Do NOT fabricate correlations — only report patterns supported by the data.',
  ].join('\n');
}

/**
 * Serializes the relevant parts of a CondensedReport into a user prompt string.
 * Includes ALL envelopes — cross-agent analysis needs the full picture from all tools.
 */
export function buildCrossAgentUserPrompt(report: PromptReportInput): string {
  const input = {
    runId: report.runId,
    environment: report.environment,
    aggregate: report.aggregate,
    toolResults: report.envelopes,
    truncated: report.truncated,
  };

  return wrapInCodeFence(
    'Analyze the following multi-tool test results and identify cross-tool correlations and blind spots.',
    JSON.stringify(input, null, 2),
  );
}
