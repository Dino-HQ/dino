/**
 * #156 / #2268 - headless init NeedsInputError descriptors (genuinely-missing flags only).
 * @internal Extracted from init-headless for max-lines; tested via init.needs-input.contract.test.ts.
 */

import type { AskUserInput } from './errors';

/** Minimal field shape used to compute genuinely-absent required flags. */
export interface NeedsInputFields {
  endpoint?: string | undefined;
  protocol?: string | undefined;
  authType?: string | undefined;
  specUrl?: string | undefined;
  authHeader?: string | undefined;
  authValueEnv?: string | undefined;
  oauth2TokenEndpoint?: string | undefined;
  oauth2ClientIdEnv?: string | undefined;
  oauth2ClientSecretEnv?: string | undefined;
  authScheme?: string | undefined;
  oauth2Scope?: string | undefined;
}

function pushHeaderAuthMissing(f: NeedsInputFields, missing: string[]): void {
  if (f.authType !== 'header') return;
  if (f.authHeader === undefined) missing.push('--auth-header');
  if (f.authValueEnv === undefined) missing.push('--auth-value-env');
}

function pushOauth2AuthMissing(f: NeedsInputFields, missing: string[]): void {
  if (f.authType !== 'oauth2') return;
  if (f.oauth2TokenEndpoint === undefined) missing.push('--oauth2-token-endpoint');
  if (f.oauth2ClientIdEnv === undefined) missing.push('--oauth2-client-id-env');
  if (f.oauth2ClientSecretEnv === undefined) missing.push('--oauth2-client-secret-env');
}

/**
 * ONLY genuinely-absent required fields (field === undefined), never invalid/incompatible values.
 * Every flag returned here MUST have a NEEDS_INPUT_DESCRIPTORS entry (INV-2).
 */
export function collectMissingRequiredFlags(f: NeedsInputFields): string[] {
  const missing: string[] = [];
  if (f.endpoint === undefined) missing.push('--endpoint');
  if (f.protocol === undefined) missing.push('--protocol');
  if (f.authType === undefined) missing.push('--auth');
  if (f.protocol === 'rest' && f.specUrl === undefined) missing.push('--spec-url');
  pushHeaderAuthMissing(f, missing);
  pushOauth2AuthMissing(f, missing);
  return missing;
}

/** Complete descriptor map for every flag collectMissingRequiredFlags can emit (all 9). */
const NEEDS_INPUT_DESCRIPTORS: ReadonlyMap<string, AskUserInput> = new Map([
  [
    '--endpoint',
    {
      field: 'endpoint',
      flag: '--endpoint',
      envVar: 'DINO_INIT_ENDPOINT',
      description: 'The API base URL to test',
      secret: false,
      reason: 'Dino needs the API base URL to write into .dino.yml and target scans.',
      example: 'https://api.example.com/graphql',
    },
  ],
  [
    '--protocol',
    {
      field: 'protocol',
      flag: '--protocol',
      envVar: 'DINO_INIT_PROTOCOL',
      description: 'graphql | rest',
      secret: false,
      reason:
        'Dino needs to know whether this API is GraphQL or REST so it picks the right discovery path.',
      example: 'graphql',
    },
  ],
  [
    '--spec-url',
    {
      field: 'specUrl',
      flag: '--spec-url',
      envVar: 'DINO_INIT_SPEC_URL',
      description: 'OpenAPI spec URL or path (required for --protocol rest)',
      secret: false,
      reason: 'REST discovery needs an OpenAPI document URL or path to learn operations.',
      example: 'https://api.example.com/openapi.json',
    },
  ],
  [
    '--auth',
    {
      field: 'authType',
      flag: '--auth',
      envVar: 'DINO_INIT_AUTH',
      description: 'none | header | oauth2',
      secret: false,
      reason: 'Dino needs the auth mode so it can record how to authenticate future scans.',
      example: 'none',
    },
  ],
  [
    '--auth-header',
    {
      field: 'authHeader',
      flag: '--auth-header',
      envVar: 'DINO_INIT_AUTH_HEADER',
      description: 'Header NAME to send the credential in (e.g. Authorization)',
      secret: false,
      reason: 'Header auth needs the HTTP header name that will carry the credential.',
      example: 'Authorization',
    },
  ],
  [
    '--oauth2-token-endpoint',
    {
      field: 'oauth2TokenEndpoint',
      flag: '--oauth2-token-endpoint',
      envVar: 'DINO_INIT_OAUTH2_TOKEN_ENDPOINT',
      description: 'OAuth2 token endpoint URL',
      secret: false,
      reason: 'OAuth2 auth needs the token endpoint URL to fetch access tokens.',
      example: 'https://idp.example.com/oauth/token',
    },
  ],
  [
    '--oauth2-client-id-env',
    {
      field: 'oauth2ClientIdEnv',
      flag: '--oauth2-client-id-env',
      envVar: 'DINO_INIT_OAUTH2_CLIENT_ID_ENV',
      description: 'NAME of the env var holding the OAuth2 client id',
      secret: false,
      reason:
        'OAuth2 needs the env-var NAME that holds the client id (never the id itself on the CLI).',
      example: 'DINO_OAUTH_CLIENT_ID',
    },
  ],
  [
    '--auth-value-env',
    {
      field: 'authValueEnv',
      flag: '--auth-value-env',
      envVar: 'DINO_INIT_AUTH_VALUE_ENV',
      description:
        'NAME of the env var holding the auth secret - set it yourself; never paste the value',
      secret: true,
      reason:
        'Header auth needs the env-var NAME that holds the credential so Dino can read it at scan time.',
      example:
        'an API key or access token; set it in the env var named by --auth-value-env (never paste the value here)',
    },
  ],
  [
    '--oauth2-client-secret-env',
    {
      field: 'oauth2ClientSecretEnv',
      flag: '--oauth2-client-secret-env',
      envVar: 'DINO_INIT_OAUTH2_CLIENT_SECRET_ENV',
      description:
        'NAME of the env var holding the OAuth2 client secret - set it yourself; never paste the value',
      secret: true,
      reason:
        'OAuth2 needs the env-var NAME that holds the client secret so Dino can read it at token exchange.',
      example:
        'an OAuth2 client secret; set it in the env var named by --oauth2-client-secret-env (never paste the value here)',
    },
  ],
]);

export function descriptorsForMissing(missing: string[]): AskUserInput[] {
  return missing.map((fl) => {
    const descriptor = NEEDS_INPUT_DESCRIPTORS.get(fl);
    if (descriptor === undefined) {
      throw new Error(`NEEDS_INPUT_DESCRIPTORS missing entry for ${fl}`);
    }
    return descriptor;
  });
}

function pushPair(args: string[], flag: string, value: string | undefined): void {
  if (value === undefined) return;
  args.push(flag, value);
}

/**
 * Build `resume.args` for a headless init NeedsInputError (#2268).
 *
 * LATENT-INVARIANT (ADR 2026-08-20-har-resume-model.md): echo-all is safe ONLY because no init
 * flag carries a raw secret value (secret:true flags carry env-var NAMES). If a value-carrying
 * secret flag is ever added, it must be filtered out of resume.args here.
 */
export function resumeArgsForInit(fields: NeedsInputFields): string[] {
  const args: string[] = ['init'];
  pushPair(args, '--endpoint', fields.endpoint);
  pushPair(args, '--protocol', fields.protocol);
  pushPair(args, '--spec-url', fields.specUrl);
  pushPair(args, '--auth', fields.authType);
  pushPair(args, '--auth-header', fields.authHeader);
  pushPair(args, '--auth-value-env', fields.authValueEnv);
  pushPair(args, '--oauth2-token-endpoint', fields.oauth2TokenEndpoint);
  pushPair(args, '--oauth2-client-id-env', fields.oauth2ClientIdEnv);
  pushPair(args, '--oauth2-client-secret-env', fields.oauth2ClientSecretEnv);
  pushPair(args, '--auth-scheme', fields.authScheme);
  pushPair(args, '--oauth2-scope', fields.oauth2Scope);
  return args;
}
