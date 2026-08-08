/**
 * #2161 — OAuth2 (client credentials) prompts + YAML emission for dino init.
 * Env-var names only; never secrets.
 */

import type { PromptObject } from 'prompts';

const STDERR = { stdout: process.stderr } as const;

export type InitOAuth2Answers = {
  type: 'oauth2';
  tokenEndpoint: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  scope?: string;
};

/** Prompt objects for the oauth2 auth arm (shown when authType === 'oauth2'). */
export function oauth2AuthPromptQuestions(): PromptObject[] {
  const whenOauth2 = (_prev: string, answers: { authType?: string }) =>
    answers.authType === 'oauth2' ? 'text' : null;

  return [
    {
      type: whenOauth2,
      name: 'oauth2TokenEndpoint',
      message: 'OAuth2 token endpoint URL?',
      validate: (v: string) => {
        try {
          new URL(v);
          return true;
        } catch {
          return 'Please enter a valid URL (e.g., https://idp.example.com/oauth/token)';
        }
      },
      ...STDERR,
    },
    {
      type: whenOauth2,
      name: 'oauth2ClientIdEnv',
      message: 'Environment variable name for the client id?',
      initial: 'DINO_OAUTH_CLIENT_ID',
      ...STDERR,
    },
    {
      type: whenOauth2,
      name: 'oauth2ClientSecretEnv',
      message: 'Environment variable name for the client secret?',
      initial: 'DINO_OAUTH_CLIENT_SECRET',
      ...STDERR,
    },
    {
      type: whenOauth2,
      name: 'oauth2Scope',
      message: 'Scope? (optional; leave empty for none)',
      initial: '',
      ...STDERR,
    },
  ];
}

export function buildOAuth2AuthAnswers(answers: {
  oauth2TokenEndpoint?: unknown;
  oauth2ClientIdEnv?: unknown;
  oauth2ClientSecretEnv?: unknown;
  oauth2Scope?: unknown;
}): InitOAuth2Answers {
  const tokenEndpoint =
    typeof answers.oauth2TokenEndpoint === 'string' ? answers.oauth2TokenEndpoint.trim() : '';
  const clientIdEnv =
    typeof answers.oauth2ClientIdEnv === 'string' && answers.oauth2ClientIdEnv.trim().length > 0
      ? answers.oauth2ClientIdEnv.trim()
      : 'DINO_OAUTH_CLIENT_ID';
  const clientSecretEnv =
    typeof answers.oauth2ClientSecretEnv === 'string' &&
    answers.oauth2ClientSecretEnv.trim().length > 0
      ? answers.oauth2ClientSecretEnv.trim()
      : 'DINO_OAUTH_CLIENT_SECRET';
  const scopeRaw = typeof answers.oauth2Scope === 'string' ? answers.oauth2Scope.trim() : '';
  return {
    type: 'oauth2',
    tokenEndpoint,
    clientIdEnv,
    clientSecretEnv,
    ...(scopeRaw.length > 0 ? { scope: scopeRaw } : {}),
  };
}

export function appendOAuth2YamlLines(lines: string[], auth: InitOAuth2Answers): void {
  lines.push(
    'auth:',
    '  type: oauth2',
    `  tokenEndpoint: ${auth.tokenEndpoint}`,
    `  clientIdEnv: ${auth.clientIdEnv}`,
    `  clientSecretEnv: ${auth.clientSecretEnv}`,
  );
  if (auth.scope && auth.scope.length > 0) {
    lines.push(`  scope: ${auth.scope}`);
  }
}

export function oauth2NextStepLines(auth: InitOAuth2Answers): string[] {
  return [
    `  export ${auth.clientIdEnv}="your-client-id"`,
    `  export ${auth.clientSecretEnv}="your-client-secret"`,
  ];
}
