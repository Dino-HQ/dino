/**
 * Shared type and utility for prompt user-prompt builders.
 *
 * Internal only — NOT re-exported from the package index.
 */

import { sanitizeLLMInput } from '../sanitize';
import { escapeCodeFence } from './base.prompt';

/**
 * Structural type for the report parameter accepted by all user-prompt builders.
 * Mirrors CondensedReport without importing from src/orchestration/ (dependency direction).
 */
export interface PromptReportInput {
  runId: string;
  tenantId: string;
  environment: string;
  aggregate: {
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    overallSeverity: string;
  };
  envelopes: ReadonlyArray<{
    toolName: string;
    severity: string;
    numericScore: number;
    total: number;
    passed: number;
    failed: number;
    findings: ReadonlyArray<{
      classification: string;
      normalizedLevel: string;
      count: number;
      examples: readonly string[];
    }>;
  }>;
  truncated: boolean;
}

/**
 * Wraps a sanitized JSON string in a code fence for LLM consumption.
 */
export function wrapInCodeFence(preamble: string, jsonString: string): string {
  const sanitizedJson = sanitizeLLMInput(jsonString);

  return [preamble, '', '```json', escapeCodeFence(sanitizedJson), '```'].join('\n');
}
