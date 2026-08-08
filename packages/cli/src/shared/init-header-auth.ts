/**
 * #2160 — header-token prompt questions for dino init.
 */

import type { PromptObject } from 'prompts';

const STDERR = { stdout: process.stderr } as const;

/** Prompt objects for the header auth arm (shown when authType === 'header'). */
export function headerAuthPromptQuestions(): PromptObject[] {
  const whenHeader = (_prev: string, answers: { authType?: string }) =>
    answers.authType === 'header' ? 'text' : null;

  return [
    {
      type: (prev: string) => (prev === 'header' ? 'text' : null),
      name: 'authHeader',
      message: 'Header name?',
      initial: 'Authorization',
      ...STDERR,
    },
    {
      type: whenHeader,
      name: 'authScheme',
      message: 'Scheme? (Bearer, or leave empty for a raw header value)',
      initial: 'Bearer',
      ...STDERR,
    },
    {
      type: whenHeader,
      name: 'authValueEnv',
      message: 'Environment variable name for your token?',
      initial: 'DINO_API_TOKEN',
      ...STDERR,
    },
  ];
}
