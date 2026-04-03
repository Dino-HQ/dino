/**
 * API Contract prompt — strategy-specific instructions for schema change analysis.
 *
 * Extends the base prompt via composeSystemPrompt(base, thisInstructions).
 * Decision #12: strategies compose, never write from scratch.
 */

import type { PromptReportInput } from './_shared';
import { wrapInCodeFence } from './_shared';

/**
 * Returns strategy-specific instructions for the Schema Change Analysis strategy.
 * This gets passed as the second argument to composeSystemPrompt(base, instructions).
 */
export function buildApiContractPromptInstructions(): string {
  return [
    'You are analyzing API contract test results from a response-validator tool.',
    'The tool compares live GraphQL API responses against their declared schema types.',
    '',
    'Your task:',
    '1. Identify which operations have schema mismatches and classify each as BREAKING, ADDITIVE, or INCONSISTENCY.',
    '   - BREAKING: Response is missing expected fields, or field types have changed (clients will break)',
    '   - ADDITIVE: Response includes extra fields not in the schema (usually safe, but may indicate undocumented changes)',
    '   - INCONSISTENCY: Execution errors or introspection failures that prevent validation',
    '2. Assess the overall risk level based on the severity and count of mismatches.',
    '3. Produce prioritized, actionable recommendations for the engineering team.',
    '',
    'Classification guide from the input data:',
    '- SCHEMA_MISMATCH (HIGH severity): Response structure does not match the declared GraphQL return type',
    '- EXTRA_FIELDS (MEDIUM severity): Response contains fields not present in the introspected schema',
    '- EXECUTION_ERROR (MEDIUM severity): The query/mutation returned a server error during validation',
    '- INTROSPECTION_FAILURE (LOW severity): Could not introspect the return type for comparison',
    '- VALID (INFO): Response matched the schema — no action needed',
    '',
    'Focus on SCHEMA_MISMATCH and EXTRA_FIELDS findings. These indicate real API contract drift.',
    'For each change, cite the specific operation name from the examples in the findings.',
    'If the data is insufficient to determine the root cause, say so explicitly.',
  ].join('\n');
}

/**
 * Serializes the relevant parts of a CondensedReport into a user prompt string.
 * Extracts response-validator envelopes and formats as JSON for the LLM.
 */
export function buildSchemaChangeUserPrompt(report: PromptReportInput): string {
  const validatorEnvelopes = report.envelopes.filter((e) => e.toolName === 'response-validator');

  const input = {
    runId: report.runId,
    environment: report.environment,
    aggregate: report.aggregate,
    responseValidatorResults: validatorEnvelopes,
    truncated: report.truncated,
  };

  return wrapInCodeFence(
    'Analyze the following API contract test results and produce a schema change analysis.',
    JSON.stringify(input, null, 2),
  );
}
