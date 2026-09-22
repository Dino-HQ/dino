/**
 * @dino/cli - CLI-specific error with exit code, optional hint, and optional cause.
 */

import { sanitizeErrorMessage } from '@dino/core';
import { stripControlsAndAnsi } from './neutralize';
import {
  boundErrorMessage,
  isTransientError,
  isUpstreamClientError,
  type OutcomeKind,
} from './outcome';

/** Matches @readme/openapi-parser ResolverError HTTP download failures (#216). */
const OPENAPI_SPEC_LOAD_HTTP = /error downloading .* http error \d+/i;
const OPENAPI_SPEC_LOAD_STATUS = /HTTP ERROR (\d+)/i;
const OPENAPI_SPEC_LOAD_URL_HTTP = /error downloading (.+?): HTTP ERROR/i;
const OPENAPI_SPEC_LOAD_URL_GENERIC = /error downloading (.+?): /i;

/**
 * The ref-parser's whole failure family — every one of these means the document could not be read
 * or dereferenced, which is the spec's problem or the network's, never Dino's. Matching only
 * `ResolverError` let the siblings escape as unhandled crashes (exit 70): pointing `--spec-url` at
 * an address Dino refuses to fetch surfaced as `Unable to resolve $ref pointer "<url>"` — a message
 * about a `$ref` the document does not even contain.
 */
const OPENAPI_SPEC_LOAD_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ResolverError',
  'UnmatchedResolverError',
  'ParserError',
  'UnmatchedParserError',
  'MissingPointerError',
  'InvalidPointerError',
]);

/** True when err is an OpenAPI spec dereference/download failure (not GraphQL introspection). */
export function isOpenApiSpecLoadError(err: unknown): boolean {
  if (err !== null && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && OPENAPI_SPEC_LOAD_ERROR_NAMES.has(name)) return true;
  }
  if (!(err instanceof Error)) return false;
  return OPENAPI_SPEC_LOAD_HTTP.test(err.message) || /resolve \$ref pointer/i.test(err.message);
}

/** HTTP status from `HTTP ERROR <n>` when present; null for network/parse failures. */
export function specLoadStatus(err: unknown): number | null {
  if (!isOpenApiSpecLoadError(err)) return null;
  const raw = err instanceof Error ? err.message : String(err);
  const match = OPENAPI_SPEC_LOAD_STATUS.exec(raw);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10);
}

/** Spec URL embedded in the openapi-parser error message, when parseable. */
export function specLoadUrl(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const httpMatch = OPENAPI_SPEC_LOAD_URL_HTTP.exec(raw);
  if (httpMatch?.[1]) return httpMatch[1].trim();
  const genericMatch = OPENAPI_SPEC_LOAD_URL_GENERIC.exec(raw);
  if (genericMatch?.[1]) return genericMatch[1].trim();
  return 'the spec URL';
}

const SPEC_LOAD_HINT = 'Check --spec-url points to a valid OpenAPI document.';

/** Rewrite an openapi-parser spec-load failure as an honest CliError (#216). */
export function toOpenApiSpecLoadCliError(err: unknown): CliError {
  const status = specLoadStatus(err);
  const url = stripControlsAndAnsi(specLoadUrl(err));
  const transient = (status !== null && status >= 500 && status < 600) || isTransientError(err);
  const kind = transient ? 'transient' : 'usage';
  const exitCode = transient ? 4 : 2;

  let rawMessage: string;
  if (transient) {
    if (status !== null && status >= 500) {
      rawMessage = `The OpenAPI spec at ${url} could not be downloaded (HTTP ${status}); retry.`;
    } else {
      rawMessage = `The OpenAPI spec at ${url} could not be downloaded; retry.`;
    }
  } else if (status !== null && status >= 400 && status < 500) {
    rawMessage = `Could not load the OpenAPI spec from ${url} (HTTP ${status}). Check --spec-url points to a valid OpenAPI document.`;
  } else {
    rawMessage = `The OpenAPI spec at ${url} is not a valid OpenAPI document.`;
  }

  const message = sanitizeErrorMessage(stripControlsAndAnsi(rawMessage));
  return new CliError(
    message,
    exitCode,
    SPEC_LOAD_HINT,
    err,
    kind,
    transient ? 'transient' : 'permanent',
  );
}

const GRAPHQL_INTROSPECTION_HINT_TRANSIENT =
  'Check the endpoint URL, authentication, or retry later.';
const GRAPHQL_INTROSPECTION_HINT_DISABLED =
  'Enable introspection on the target API, or add schemaPath to your API config for offline mode.';
const GRAPHQL_INTROSPECTION_HINT_USAGE = 'Check the endpoint URL and authentication.';

function introspectionResponseStatus(err: unknown): number | null {
  if (!isUpstreamClientError(err)) return null;
  const response = err.response;
  if (response === null || typeof response !== 'object') return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function hasGraphqlErrorsBody(err: unknown): boolean {
  if (!isUpstreamClientError(err)) return false;
  const response = err.response;
  if (response === null || typeof response !== 'object') return false;
  const errors = (response as { errors?: unknown }).errors;
  return Array.isArray(errors) && errors.length > 0;
}

function looksLikeIntrospectionDisabled(err: unknown): boolean {
  if (!isUpstreamClientError(err)) return false;
  const response = err.response;
  if (response === null || typeof response !== 'object') return false;
  const errors = (response as { errors?: { message?: string }[] }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    if (e === null || typeof e !== 'object') return false;
    const msg = (typeof e.message === 'string' ? e.message : '').toLowerCase();
    return (
      msg.includes('introspection') &&
      (msg.includes('not allowed') || msg.includes('disabled') || msg.includes('not enabled'))
    );
  });
}

function boundSanitizedText(text: string): string {
  // keep the single-line collapse in sync with boundErrorMessage (outcome.ts) — prevents CWE-117
  const sanitized = sanitizeErrorMessage(stripControlsAndAnsi(text).replaceAll(/\s+/g, ' ').trim());
  return sanitized.length > 300 ? `${sanitized.slice(0, 300)}…` : sanitized;
}

function graphqlErrorMessagesFromResponse(response: unknown): string[] {
  if (response === null || typeof response !== 'object') return [];
  const errors = (response as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return [];
  const parts: string[] = [];
  for (const entry of errors) {
    if (entry === null || typeof entry !== 'object') continue;
    const message = (entry as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      parts.push(message);
    }
  }
  return parts;
}

function graphqlTargetErrorText(err: unknown): string {
  if (!isUpstreamClientError(err)) return boundErrorMessage(err);
  const parts = graphqlErrorMessagesFromResponse(err.response);
  if (parts.length === 0) return boundErrorMessage(err);
  return boundSanitizedText(parts.join('; '));
}

function buildGraphqlIntrospectionMessage(
  transient: boolean,
  safeEndpoint: string,
  status: number | null,
  errorText: string,
): string {
  if (transient) {
    if (status !== null) {
      return `GraphQL introspection at ${safeEndpoint} failed (HTTP ${status}): ${errorText}; retry.`;
    }
    return `GraphQL introspection at ${safeEndpoint} failed: ${errorText}; retry.`;
  }
  if (status !== null && status >= 400 && status < 500) {
    return `GraphQL introspection at ${safeEndpoint} failed (HTTP ${status}): ${errorText}. Check the endpoint and authentication.`;
  }
  return `GraphQL introspection at ${safeEndpoint} failed: ${errorText}. Check the endpoint and authentication.`;
}

/** Rewrite a graphql-request introspection ClientError as an honest CliError (#231). */
function introspectionHintFor(transient: boolean, err: unknown): string {
  if (transient) return GRAPHQL_INTROSPECTION_HINT_TRANSIENT;
  if (looksLikeIntrospectionDisabled(err)) return GRAPHQL_INTROSPECTION_HINT_DISABLED;
  return GRAPHQL_INTROSPECTION_HINT_USAGE;
}

export function toGraphqlIntrospectionCliError(err: unknown, endpoint: string): CliError {
  const status = introspectionResponseStatus(err);
  const transient =
    isTransientError(err) || (hasGraphqlErrorsBody(err) && !looksLikeIntrospectionDisabled(err));
  const kind = transient ? 'transient' : 'usage';
  const exitCode = transient ? 4 : 2;
  const safeEndpoint = stripControlsAndAnsi(endpoint);
  const errorText = graphqlTargetErrorText(err);
  const rawMessage = buildGraphqlIntrospectionMessage(transient, safeEndpoint, status, errorText);

  const message = sanitizeErrorMessage(stripControlsAndAnsi(rawMessage));
  return new CliError(
    message,
    exitCode,
    introspectionHintFor(transient, err),
    err,
    kind,
    transient ? 'transient' : 'permanent',
  );
}

/** Throw a tenant-config CliError with honest config/usage kind (#241). */
export function throwTenantConfigCliError(
  message: string,
  kind: 'config' | 'usage',
  hint = 'Run dino validate to check your config.',
): never {
  const exitCode = kind === 'usage' ? 2 : 5;
  throw new CliError(message, exitCode, hint, undefined, kind);
}

/** Detect the AbortController timeout signature from plugin.discover. INV-UX-1. */
export function isIntrospectionTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // AbortError or timeout message; unparenthesized || is intentional (Prettier / Maciver LOW).
  return err.name === 'AbortError' || err.message.includes('aborted due to timeout');
}

/** Build the actionable CliError for a timeout. INV-UX-2, INV-UX-3. */
export function buildIntrospectionTimeoutError(
  endpoint: string,
  timeoutMs: number,
  cause: unknown,
): CliError {
  const message = `Introspection timed out after ${timeoutMs}ms.\nEndpoint: ${endpoint}`;
  const hint = [
    'Common causes:',
    '  • Endpoint does not support GraphQL introspection at this path',
    `  • Path suffix missing - try ${endpoint.replace(/\/?$/, '/graphql')}`,
    '  • Authentication required but not configured (run: dino init)',
    '  • Endpoint unreachable from this network',
  ].join('\n');
  return new CliError(message, 1, hint, cause);
}

export type CliErrorRetryable = 'transient' | 'permanent';

export interface CliErrorOptions {
  exitCode?: number;
  hint?: string;
  cause?: unknown;
  kind?: OutcomeKind;
  retryable?: CliErrorRetryable;
}

/**
 * CLI-specific error with exit code and optional user-facing hint.
 * Positional constructor kept for the 7+ callers that pass `cause` as the 4th arg (#2173).
 * New `kind`/`retryable` MUST stay after `cause` (positions 5/6).
 */
export class CliError extends Error {
  public readonly exitCode: number;
  public readonly hint?: string;
  public readonly kind?: OutcomeKind;
  public readonly retryable: CliErrorRetryable;

  // Spec #2173: kind/retryable AFTER cause - exceeds max-params by design (positional compat).
  // biome-ignore lint/complexity/useMaxParams: handover requires positions 5/6 after cause
  constructor(
    message: string,
    exitCode: number = 1,
    hint?: string,
    cause?: unknown,
    kind?: OutcomeKind,
    retryable: CliErrorRetryable = 'permanent',
  ) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    if (hint !== undefined) this.hint = hint;
    if (cause !== undefined) {
      // ES2022 Error.cause - preserves the original error for DEBUG=1 surfaces and tooling.
      (this as Error & { cause?: unknown }).cause = cause;
    }
    if (kind !== undefined) this.kind = kind;
    this.retryable = retryable;
  }
}

export interface AskUserInput {
  field: string; // logical field, e.g. 'endpoint'
  flag: string; // '--endpoint'
  envVar: string; // 'DINO_INIT_ENDPOINT'
  description: string; // static help text
  secret: boolean; // true → agent must ask the human to set the env var, never solicit the value
  /** WHY Dino needs this value (#2268). */
  reason: string;
  /** Expected format. For secret:true: shape + destination, NEVER a credential value (#2268). */
  example: string;
}

/** Structured re-invocation - never a shell string (#2268 / HAR resume model). */
export interface AskUserResume {
  type: 'run_command';
  bin: 'dino';
  args: string[];
}

export interface AskUserNextAction {
  type: 'ask_user';
  inputs: AskUserInput[];
  resume: AskUserResume;
}

/** A usage error that also tells an agent, structurally, what to ask the human for.
 *  Carries nextAction as its own readonly field so CliError's positional constructor is untouched. */
export class NeedsInputError extends CliError {
  public readonly nextAction: AskUserNextAction;
  constructor(message: string, hint: string, inputs: AskUserInput[], resume: AskUserResume) {
    super(message, 2, hint, undefined, 'usage'); // exit 2, kind 'usage' - unchanged contract
    this.name = 'NeedsInputError';
    this.nextAction = { type: 'ask_user', inputs, resume };
  }
}

export function hasNextAction(e: unknown): e is { nextAction: AskUserNextAction } {
  return e instanceof CliError && (e as { nextAction?: unknown }).nextAction !== undefined;
}
