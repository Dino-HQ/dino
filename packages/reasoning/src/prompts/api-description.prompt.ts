/**
 * API Description prompt — strategy-specific instructions for generating operation descriptions.
 *
 * Extends the base prompt via composeSystemPrompt(base, thisInstructions).
 * Decision #12: strategies compose, never write from scratch.
 */

import type { ApiDescriptionEntry } from '../strategies/api-description.strategy';
import { sanitizeLLMInput } from '../sanitize';
import { escapeCodeFence } from './base.prompt';

/**
 * Returns strategy-specific instructions for the API Description strategy.
 * This gets passed as the second argument to composeSystemPrompt(base, instructions).
 */
export function buildApiDescriptionPromptInstructions(): string {
  return [
    'You are generating short, consistent descriptions for GraphQL API operations that lack schema-level descriptions.',
    'The input lists operations with their type (query/mutation/subscription), arguments, return type, deprecation status, and any tool findings from QA runs.',
    '',
    'Your task:',
    '1. For each operation in the input, produce one description object with:',
    '   - operationName: the operation name (string).',
    '   - description: a short description (1–2 sentences) of what the operation does.',
    '   - authRequired: "yes", "no", or "unknown" based on naming/auth conventions or tool findings.',
    '   - sideEffects: array of up to 5 short strings describing side effects (e.g. "Updates user record", "Sends email"). Empty array if none inferred.',
    '   - relatedOperations: array of up to 5 operation names that are typically used with this one. Empty if none inferred.',
    '   - confidence: "high", "medium", or "low" (high = clear from naming/signatures, low = little context).',
    '2. At the top level, include batchSummary: a brief string summarizing the batch (e.g. "3 user queries, 2 payment mutations").',
    '3. Use operation name, arguments, return type, and tool findings to infer purpose. Keep descriptions factual. Do not invent behavior.',
    '',
    'Output format: JSON object with "batchSummary" (string) and "descriptions" (array). Include exactly one description per operation in the input.',
  ].join('\n');
}

/**
 * Builds the user prompt: groups entries by module and serializes as JSON for the LLM.
 */
export function buildApiDescriptionUserPrompt(entries: ApiDescriptionEntry[]): string {
  const byModule: Record<string, ApiDescriptionEntry[]> = {};
  for (const e of entries) {
    const list = byModule[e.module] ?? [];
    list.push(e);
    byModule[e.module] = list;
  }

  const modules = Object.entries(byModule).map(([name, ops]) => ({
    name,
    operations: ops.map((op) => ({
      name: op.name,
      type: op.type,
      args: op.args,
      returnType: op.returnType,
      deprecated: op.deprecated,
      toolFindings: op.toolFindings,
    })),
  }));

  const payload = {
    totalOperations: entries.length,
    modules,
  };

  const sanitizedJson = sanitizeLLMInput(JSON.stringify(payload, null, 2));

  return [
    'Generate short descriptions for the following API operations. They have no schema description yet; use name, args, return type, and tool findings to infer purpose.',
    '',
    '```json',
    escapeCodeFence(sanitizedJson),
    '```',
  ].join('\n');
}
