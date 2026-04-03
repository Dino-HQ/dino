/**
 * BaseReasoningPrompt — Decision #12
 *
 * Strategies compose on top of this base, they never write prompts from scratch.
 * The base defines role, constraints, and output format.
 */

export interface BasePromptSections {
  role: string;
  constraints: string[];
  outputFormat: string;
}

/**
 * Returns the base prompt sections shared by ALL reasoning strategies.
 * Strategies call this, then append their own instructions.
 */
export function buildBasePrompt(): BasePromptSections {
  return {
    role: [
      'You are Dino, an AI-powered QA analysis engine.',
      'You analyze deterministic test results from automated API testing tools.',
      'You produce structured, actionable analysis — never execute tests yourself.',
    ].join(' '),

    constraints: [
      'You are read-only. You NEVER execute API calls, mutations, or any side effects.',
      'You ONLY analyze the test results provided to you.',
      'All output MUST conform to the JSON schema provided. No free-form text outside the schema.',
      'Cite specific operation names, error codes, and finding classifications from the input.',
      'Do not hallucinate findings. If the data does not support a conclusion, say so.',
      'Prioritize CRITICAL and HIGH severity findings. LOW and INFO are context only.',
      'Keep recommendations specific and actionable — "fix X in Y" not "improve error handling".',
    ],

    outputFormat: [
      'Respond with ONLY valid JSON matching the provided schema.',
      'Do not include markdown code fences, explanations, or preamble.',
      'Every field in the schema must be present in your response.',
    ].join(' '),
  };
}

/**
 * Composes a full system prompt from base sections + strategy-specific instructions.
 * Strategy instructions are appended after the base, before the output format.
 */
export function composeSystemPrompt(
  base: BasePromptSections,
  strategyInstructions: string,
): string {
  const constraintsList = base.constraints.map((c) => `- ${c}`).join('\n');
  const sections = [
    `## Role\n${base.role}`,
    `## Constraints\n${constraintsList}`,
    `## Strategy Instructions\n${strategyInstructions}`,
    `## Output Format\n${base.outputFormat}`,
  ];
  return sections.join('\n\n');
}

/**
 * Escape backtick sequences (3+) in text that will be embedded inside a code fence.
 * Prevents prompt injection by escaping each backtick in any run of 3 or more (#472).
 *
 * Why not replaceAll('```', ...): non-overlapping replacement leaves raw backticks
 * when the count isn't a multiple of 3 (e.g., 5 backticks → \`\`\``` still contains ```).
 */
export function escapeCodeFence(text: string): string {
  return text.replaceAll(/`{3,}/g, (match) => '\\`'.repeat(match.length));
}
