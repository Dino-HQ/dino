/**
 * #2198 — headless / non-interactive dino init resolver (UI-free).
 */

import { buildAuthAnswers, type InitAuthAnswers } from './config-yaml';
import { CliError } from './errors';

export interface HeadlessInitInputs {
  endpoint?: string;
  protocol?: string;
  specUrl?: string;
  authType?: string;
  authHeader?: string;
  authScheme?: string;
  authValueEnv?: string;
  oauth2TokenEndpoint?: string;
  oauth2ClientIdEnv?: string;
  oauth2ClientSecretEnv?: string;
  oauth2Scope?: string;
  yes?: boolean;
}

export interface InitResultDoc {
  changed: boolean;
  dryRun?: true;
  path: '.dino.yml';
  endpoint: string;
  protocol: string;
  yaml?: string;
}

const ENV_NAME = /^[A-Za-z_]\w*$/;
const HTTP_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const AUTH_SCHEME = /^[A-Za-z0-9-]+$/;

interface HeadlessRawFields {
  endpointRaw?: string | undefined;
  protocolRaw?: string | undefined;
  specUrlRaw?: string | undefined;
  authTypeRaw?: string | undefined;
  authHeaderRaw?: string | undefined;
  authSchemeRaw?: string | undefined;
  authValueEnvRaw?: string | undefined;
  oauth2TokenEndpointRaw?: string | undefined;
  oauth2ClientIdEnvRaw?: string | undefined;
  oauth2ClientSecretEnvRaw?: string | undefined;
  oauth2ScopeRaw?: string | undefined;
}

interface HeadlessTrimmedFields {
  endpoint?: string | undefined;
  protocol?: string | undefined;
  specUrl?: string | undefined;
  authType?: string | undefined;
  authHeader?: string | undefined;
  authScheme?: string | undefined;
  authValueEnv?: string | undefined;
  oauth2TokenEndpoint?: string | undefined;
  oauth2ClientIdEnv?: string | undefined;
  oauth2ClientSecretEnv?: string | undefined;
  oauth2Scope?: string | undefined;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickString(flagVal: unknown, envVal: string | undefined): string | undefined {
  if (typeof flagVal === 'string') return flagVal;
  return envVal;
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function containsControlChar(value: string): boolean {
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) <= 0x1f) return true;
  }
  return false;
}

/** Returns `label` when the value is present, else null (a positive-condition builder). */
function flagIfPresent(label: string, value: string | undefined): string | null {
  return value === undefined ? null : label;
}

function pushControlCharProblem(
  problems: string[],
  label: string,
  value: string | undefined,
): void {
  if (value !== undefined && containsControlChar(value)) {
    problems.push(label);
  }
}

function readRawFields(inputs: HeadlessInitInputs): HeadlessRawFields {
  return {
    endpointRaw: pickString(inputs.endpoint, undefined),
    protocolRaw: pickString(inputs.protocol, undefined),
    specUrlRaw: pickString(inputs.specUrl, undefined),
    authTypeRaw: pickString(inputs.authType, undefined),
    authHeaderRaw: pickString(inputs.authHeader, undefined),
    authSchemeRaw: pickString(inputs.authScheme, undefined),
    authValueEnvRaw: pickString(inputs.authValueEnv, undefined),
    oauth2TokenEndpointRaw: pickString(inputs.oauth2TokenEndpoint, undefined),
    oauth2ClientIdEnvRaw: pickString(inputs.oauth2ClientIdEnv, undefined),
    oauth2ClientSecretEnvRaw: pickString(inputs.oauth2ClientSecretEnv, undefined),
    oauth2ScopeRaw: pickString(inputs.oauth2Scope, undefined),
  };
}

function trimFields(raw: HeadlessRawFields): HeadlessTrimmedFields {
  return {
    endpoint: trimOrUndefined(raw.endpointRaw),
    protocol: trimOrUndefined(raw.protocolRaw),
    specUrl: trimOrUndefined(raw.specUrlRaw),
    authType: trimOrUndefined(raw.authTypeRaw),
    authHeader: trimOrUndefined(raw.authHeaderRaw),
    authScheme: trimOrUndefined(raw.authSchemeRaw),
    authValueEnv: trimOrUndefined(raw.authValueEnvRaw),
    oauth2TokenEndpoint: trimOrUndefined(raw.oauth2TokenEndpointRaw),
    oauth2ClientIdEnv: trimOrUndefined(raw.oauth2ClientIdEnvRaw),
    oauth2ClientSecretEnv: trimOrUndefined(raw.oauth2ClientSecretEnvRaw),
    oauth2Scope: trimOrUndefined(raw.oauth2ScopeRaw),
  };
}

function collectRequiredProblems(fields: HeadlessTrimmedFields): string[] {
  const problems: string[] = [];
  if (fields.endpoint === undefined) problems.push('--endpoint');
  if (fields.protocol === undefined) problems.push('--protocol');
  if (fields.authType === undefined) problems.push('--auth');
  return problems;
}

function collectProtocolProblems(fields: HeadlessTrimmedFields): string[] {
  const problems: string[] = [];
  const { protocol, specUrl, authType } = fields;
  if (protocol !== undefined && protocol !== 'graphql' && protocol !== 'rest') {
    problems.push('--protocol');
  }
  if (protocol === 'rest' && specUrl === undefined) problems.push('--spec-url');
  if (protocol === 'graphql' && specUrl !== undefined) problems.push('--spec-url');
  if (
    authType !== undefined &&
    authType !== 'none' &&
    authType !== 'header' &&
    authType !== 'oauth2'
  ) {
    problems.push('--auth');
  }
  return problems;
}

function collectAuthRequiredProblems(fields: HeadlessTrimmedFields): string[] {
  const problems: string[] = [];
  if (fields.authType === 'header') {
    if (fields.authHeader === undefined) problems.push('--auth-header');
    if (fields.authValueEnv === undefined) problems.push('--auth-value-env');
  }
  if (fields.authType === 'oauth2') {
    if (fields.oauth2TokenEndpoint === undefined) problems.push('--oauth2-token-endpoint');
    if (fields.oauth2ClientIdEnv === undefined) problems.push('--oauth2-client-id-env');
    if (fields.oauth2ClientSecretEnv === undefined) problems.push('--oauth2-client-secret-env');
  }
  return problems;
}

function collectNoneAuthExtraProblems(fields: HeadlessTrimmedFields): string[] {
  const authDetailFlags = [
    flagIfPresent('--auth-header', fields.authHeader),
    flagIfPresent('--auth-scheme', fields.authScheme),
    flagIfPresent('--auth-value-env', fields.authValueEnv),
    flagIfPresent('--oauth2-token-endpoint', fields.oauth2TokenEndpoint),
    flagIfPresent('--oauth2-client-id-env', fields.oauth2ClientIdEnv),
    flagIfPresent('--oauth2-client-secret-env', fields.oauth2ClientSecretEnv),
    flagIfPresent('--oauth2-scope', fields.oauth2Scope),
  ].filter((flag): flag is string => flag !== null);
  return fields.authType === 'none' ? authDetailFlags : [];
}

function collectHeaderAuthExtraProblems(fields: HeadlessTrimmedFields): string[] {
  if (fields.authType !== 'header') return [];
  return [
    flagIfPresent('--oauth2-token-endpoint', fields.oauth2TokenEndpoint),
    flagIfPresent('--oauth2-client-id-env', fields.oauth2ClientIdEnv),
    flagIfPresent('--oauth2-client-secret-env', fields.oauth2ClientSecretEnv),
    flagIfPresent('--oauth2-scope', fields.oauth2Scope),
  ].filter((flag): flag is string => flag !== null);
}

function collectOauth2AuthExtraProblems(fields: HeadlessTrimmedFields): string[] {
  if (fields.authType !== 'oauth2') return [];
  return [
    flagIfPresent('--auth-header', fields.authHeader),
    flagIfPresent('--auth-scheme', fields.authScheme),
    flagIfPresent('--auth-value-env', fields.authValueEnv),
  ].filter((flag): flag is string => flag !== null);
}

function collectAuthCrossProblems(fields: HeadlessTrimmedFields): string[] {
  return [
    ...collectNoneAuthExtraProblems(fields),
    ...collectHeaderAuthExtraProblems(fields),
    ...collectOauth2AuthExtraProblems(fields),
  ];
}

function collectEnvNameProblems(fields: HeadlessTrimmedFields): string[] {
  const problems: string[] = [];
  if (fields.authValueEnv !== undefined && !ENV_NAME.test(fields.authValueEnv)) {
    problems.push('--auth-value-env');
  }
  if (fields.oauth2ClientIdEnv !== undefined && !ENV_NAME.test(fields.oauth2ClientIdEnv)) {
    problems.push('--oauth2-client-id-env');
  }
  if (fields.oauth2ClientSecretEnv !== undefined && !ENV_NAME.test(fields.oauth2ClientSecretEnv)) {
    problems.push('--oauth2-client-secret-env');
  }
  return problems;
}

function collectValueProblems(fields: HeadlessTrimmedFields): string[] {
  const problems: string[] = [];
  const { endpoint, oauth2TokenEndpoint } = fields;

  if (endpoint !== undefined && !isAbsoluteUrl(endpoint)) problems.push('--endpoint');
  if (oauth2TokenEndpoint !== undefined && !isAbsoluteUrl(oauth2TokenEndpoint)) {
    problems.push('--oauth2-token-endpoint');
  }
  problems.push(...collectEnvNameProblems(fields));
  if (fields.authHeader !== undefined && !HTTP_HEADER_NAME.test(fields.authHeader)) {
    problems.push('--auth-header');
  }
  if (fields.authScheme !== undefined && !AUTH_SCHEME.test(fields.authScheme)) {
    problems.push('--auth-scheme');
  }
  if (fields.oauth2Scope !== undefined && /#/.test(fields.oauth2Scope)) {
    problems.push('--oauth2-scope');
  }
  return problems;
}

function collectControlCharProblems(raw: HeadlessRawFields): string[] {
  const problems: string[] = [];
  for (const [label, value] of [
    ['--endpoint', raw.endpointRaw],
    ['--protocol', raw.protocolRaw],
    ['--spec-url', raw.specUrlRaw],
    ['--auth', raw.authTypeRaw],
    ['--auth-header', raw.authHeaderRaw],
    ['--auth-scheme', raw.authSchemeRaw],
    ['--auth-value-env', raw.authValueEnvRaw],
    ['--oauth2-token-endpoint', raw.oauth2TokenEndpointRaw],
    ['--oauth2-client-id-env', raw.oauth2ClientIdEnvRaw],
    ['--oauth2-client-secret-env', raw.oauth2ClientSecretEnvRaw],
    ['--oauth2-scope', raw.oauth2ScopeRaw],
  ] as const) {
    pushControlCharProblem(problems, label, value);
  }
  return problems;
}

function collectEmptyOverrideProblems(
  raw: HeadlessRawFields,
  fields: HeadlessTrimmedFields,
): string[] {
  const problems: string[] = [];
  if (raw.endpointRaw !== undefined && fields.endpoint === undefined) problems.push('--endpoint');
  if (raw.protocolRaw !== undefined && fields.protocol === undefined) problems.push('--protocol');
  if (raw.authTypeRaw !== undefined && fields.authType === undefined) problems.push('--auth');
  if (raw.authValueEnvRaw !== undefined && fields.authValueEnv === undefined) {
    problems.push('--auth-value-env');
  }
  if (raw.oauth2ClientIdEnvRaw !== undefined && fields.oauth2ClientIdEnv === undefined) {
    problems.push('--oauth2-client-id-env');
  }
  if (raw.oauth2ClientSecretEnvRaw !== undefined && fields.oauth2ClientSecretEnv === undefined) {
    problems.push('--oauth2-client-secret-env');
  }
  return problems;
}

const BASE_USAGE_SUGGESTION =
  'pass --endpoint <url>, --protocol graphql|rest, --auth none|header|oauth2 (or the matching DINO_INIT_* env vars)';

/**
 * Protocol-specific remediation for the spec-url incompatibilities (QA #443): a spec URL
 * (from --spec-url or DINO_INIT_SPEC_URL) belongs only to REST, so an agent switching a
 * REST env config to GraphQL by flag needs to be told to drop the inherited spec URL.
 */
function buildUsageSuggestion(fields: HeadlessTrimmedFields): string {
  if (fields.protocol === 'graphql' && fields.specUrl !== undefined) {
    return 'remove --spec-url (or unset DINO_INIT_SPEC_URL); a spec URL applies only to --protocol rest';
  }
  if (fields.protocol === 'rest' && fields.specUrl === undefined) {
    return 'add --spec-url <url or path>; --protocol rest requires an OpenAPI spec';
  }
  return BASE_USAGE_SUGGESTION;
}

function throwUsageIfProblems(problems: string[], suggestion: string): void {
  const uniqueProblems = [...new Set(problems)];
  if (uniqueProblems.length === 0) return;
  throw new CliError(
    `missing or invalid input: ${uniqueProblems.join(', ')}`,
    2,
    suggestion,
    undefined,
    'usage',
  );
}

/** INV-6: interactive only when BOTH std streams are TTYs and --yes is absent. */
export function isNonInteractiveInit(
  inputs: { yes?: boolean },
  deps?: { stdinTTY?: boolean; stdoutTTY?: boolean },
): boolean {
  if (inputs.yes === true) return true;
  const stdinTTY = deps?.stdinTTY ?? process.stdin.isTTY === true;
  const stdoutTTY = deps?.stdoutTTY ?? process.stdout.isTTY === true;
  return !(stdinTTY && stdoutTTY);
}

/** INV-7: flag > DINO_INIT_* env > undefined. No unrelated-env inference. */
export function gatherHeadlessInputs(
  flags: Record<string, unknown>,
  env: Record<string, string | undefined>,
): HeadlessInitInputs {
  const out: HeadlessInitInputs = {};
  const endpoint = pickString(flags.endpoint, env.DINO_INIT_ENDPOINT);
  if (endpoint !== undefined) out.endpoint = endpoint;
  const protocol = pickString(flags.protocol, env.DINO_INIT_PROTOCOL);
  if (protocol !== undefined) out.protocol = protocol;
  const specUrl = pickString(flags.specUrl, env.DINO_INIT_SPEC_URL);
  if (specUrl !== undefined) out.specUrl = specUrl;
  const authType = pickString(flags.auth, env.DINO_INIT_AUTH);
  if (authType !== undefined) out.authType = authType;
  const authHeader = pickString(flags.authHeader, env.DINO_INIT_AUTH_HEADER);
  if (authHeader !== undefined) out.authHeader = authHeader;
  const authScheme = pickString(flags.authScheme, env.DINO_INIT_AUTH_SCHEME);
  if (authScheme !== undefined) out.authScheme = authScheme;
  const authValueEnv = pickString(flags.authValueEnv, env.DINO_INIT_AUTH_VALUE_ENV);
  if (authValueEnv !== undefined) out.authValueEnv = authValueEnv;
  const oauth2TokenEndpoint = pickString(
    flags.oauth2TokenEndpoint,
    env.DINO_INIT_OAUTH2_TOKEN_ENDPOINT,
  );
  if (oauth2TokenEndpoint !== undefined) out.oauth2TokenEndpoint = oauth2TokenEndpoint;
  const oauth2ClientIdEnv = pickString(flags.oauth2ClientIdEnv, env.DINO_INIT_OAUTH2_CLIENT_ID_ENV);
  if (oauth2ClientIdEnv !== undefined) out.oauth2ClientIdEnv = oauth2ClientIdEnv;
  const oauth2ClientSecretEnv = pickString(
    flags.oauth2ClientSecretEnv,
    env.DINO_INIT_OAUTH2_CLIENT_SECRET_ENV,
  );
  if (oauth2ClientSecretEnv !== undefined) out.oauth2ClientSecretEnv = oauth2ClientSecretEnv;
  const oauth2Scope = pickString(flags.oauth2Scope, env.DINO_INIT_OAUTH2_SCOPE);
  if (oauth2Scope !== undefined) out.oauth2Scope = oauth2Scope;
  if (flags.yes === true) out.yes = true;
  return out;
}

export function buildInitResultDoc(fields: InitResultDoc): string {
  return JSON.stringify(fields);
}

/** INV-3/9/10: collect ALL missing/invalid inputs; throw one usage CliError or return answers. */
export function resolveHeadlessInitAnswers(inputs: HeadlessInitInputs): {
  endpoint: string;
  protocol: string;
  auth: InitAuthAnswers;
  specUrl?: string;
} {
  const raw = readRawFields(inputs);
  const fields = trimFields(raw);
  throwUsageIfProblems(
    [
      ...collectRequiredProblems(fields),
      ...collectProtocolProblems(fields),
      ...collectAuthRequiredProblems(fields),
      ...collectAuthCrossProblems(fields),
      ...collectValueProblems(fields),
      ...collectControlCharProblems(raw),
      ...collectEmptyOverrideProblems(raw, fields),
    ],
    buildUsageSuggestion(fields),
  );

  const { endpoint, protocol, authType, specUrl } = fields;
  if (endpoint === undefined || protocol === undefined || authType === undefined) {
    throw new CliError(
      'missing or invalid input: --endpoint, --protocol, --auth',
      2,
      'pass --endpoint <url>, --protocol graphql|rest, --auth none|header|oauth2 (or the matching DINO_INIT_* env vars)',
      undefined,
      'usage',
    );
  }

  const auth = buildAuthAnswers({
    authType,
    authHeader: fields.authHeader,
    authScheme: fields.authScheme,
    authValueEnv: fields.authValueEnv,
    oauth2TokenEndpoint: fields.oauth2TokenEndpoint,
    oauth2ClientIdEnv: fields.oauth2ClientIdEnv,
    oauth2ClientSecretEnv: fields.oauth2ClientSecretEnv,
    oauth2Scope: fields.oauth2Scope,
  });

  return {
    endpoint,
    protocol,
    auth: auth ?? { type: 'none' },
    ...(protocol === 'rest' && specUrl !== undefined ? { specUrl } : {}),
  };
}
