/**
 * @dino/cli — permanent exit-code contract + error envelope (#2173).
 * Normative: output-observability-contract.md §5A.2 / §5A.7.
 */

import {
  DinoError,
  type DinoErrorCode,
  errorContractFor,
  isTenantConfigError,
  type OutcomeKind,
  SsrfBlockedError,
  sanitizeErrorMessage,
  winningKind,
} from '@dino/core';
import { type AskUserNextAction, CliError, hasNextAction } from './errors';
import { stripControlsAndAnsi } from './neutralize';
import { ENVELOPE_EXIT_CODES } from './output-contract';

/** True when err is an SSRF/DNS block the CLI should treat as usage (exit 2), not crash (#193).
 *  Prefix match only - a mid-message "SSRF blocked:" (e.g. wrapped GraphQL errors[]) must NOT match. */
export function isSsrfBlockedError(err: unknown): boolean {
  if (err instanceof SsrfBlockedError) return true;
  return err instanceof Error && err.message.startsWith('SSRF blocked:');
}

/** graphql-request ClientError shape: message embeds `: {"response":…,"request":{"query":…}}`. */
export function isUpstreamClientError(
  err: unknown,
): err is Error & { response: unknown; request: unknown } {
  return err instanceof Error && 'response' in err && 'request' in err;
}

/**
 * ONE canonical bounded message: strip the graphql-request dump (narrow `: {"response":` sentinel
 * only), neutralize attacker-controlled control/ANSI, collapse to a single line, cap LAST.
 */
export function boundErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const dumpIdx = isUpstreamClientError(err) ? raw.indexOf(': {"response":') : -1;
  const base = dumpIdx >= 0 ? raw.slice(0, dumpIdx) : raw;
  const oneLine = stripControlsAndAnsi(base).replaceAll(/\s+/g, ' ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

/** The table, precedence and resolver live in `@dino/core` (Cleanup V2 task 2); re-exported unchanged. */
export { EXIT_CODE, type OutcomeKind, resolveExitCode } from '@dino/core';

export interface RuntimeOutcomeError {
  kind: string;
  message: string;
  retryable: 'transient' | 'permanent';
  /** Stable Dino identity when known (DinoError, a cloud error body, or a CliError carrying one). */
  code?: DinoErrorCode;
  input?: unknown;
  suggestion?: string;
  nextAction?: AskUserNextAction;
}

export interface RuntimeOutcome {
  kind: OutcomeKind;
  /** Concurrent kinds; highest-precedence kind wins (INV precedence). */
  also?: readonly OutcomeKind[];
  /** `--accept-partial` downgrades a winning `partial` to exit 0 (INV-1). */
  acceptPartial?: boolean;
  error?: RuntimeOutcomeError;
}


/** Pure: JSON envelope string for exits 2/4/5/70; null otherwise (INV-3). */
export function envelopeFor(o: RuntimeOutcome, exitCode: number): string | null {
  if (!ENVELOPE_EXIT_CODES.has(exitCode)) return null;
  const fallbackRetryable: 'transient' | 'permanent' = exitCode === 4 ? 'transient' : 'permanent';
  const err = o.error ?? {
    kind: winningKind(o),
    message: '',
    retryable: fallbackRetryable,
  };
  const body: Record<string, unknown> = {
    kind: err.kind,
    message: sanitizeErrorMessage(err.message),
    retryable: err.retryable,
    exitCode,
  };
  // D2: the stable Dino identity, additive, so an agent keys on the same code HTTP sends.
  if (err.code !== undefined) body.code = err.code;
  if (err.input !== undefined) body.input = sanitizeInput(err.input);
  if (err.suggestion !== undefined) body.suggestion = sanitizeErrorMessage(err.suggestion);
  const out: Record<string, unknown> = { error: body };
  if (o.error?.nextAction !== undefined) out.nextAction = o.error.nextAction;
  return JSON.stringify(out);
}

/**
 * Sanitize the echoed `input` (§5A.2) so a secret-bearing flag (e.g. `--token sk-live-…`)
 * can never reach the stderr envelope. Covers the realistic echoed forms — a joined string
 * or an argv array; structured objects pass through (caller-controlled, not free-text).
 */
function sanitizeInput(input: unknown): unknown {
  if (typeof input === 'string') return sanitizeErrorMessage(input);
  if (Array.isArray(input)) {
    return input.map((v) => (typeof v === 'string' ? sanitizeErrorMessage(v) : v));
  }
  return input;
}

/**
 * Leg-vs-target rate-limit outcome (§5A.8): one limited leg + others OK → partial;
 * nothing scanned → transient rate_limited.
 */
export function outcomeFromRateLimitLegs(opts: {
  okLegs: number;
  rateLimitedLegs: number;
}): RuntimeOutcome {
  if (opts.okLegs <= 0) {
    return {
      kind: 'transient',
      error: {
        kind: 'rate_limited',
        message: 'Target rate-limited; nothing scanned',
        retryable: 'transient',
      },
    };
  }
  if (opts.rateLimitedLegs > 0) {
    return { kind: 'partial' };
  }
  return { kind: 'clean' };
}

/** Write the envelope as the last stderr line when non-null (INV-3). */
export function emitEnvelope(envelope: string | null): void {
  if (envelope !== null) {
    console.error(envelope);
  }
}

/** Structured node network codes - matched on err.code ONLY (no message substring). */
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);
/** Space/underscore idiom markers - appear only in real error text, not filename tokens.
 *  (No single tokens like 'ECONNRESET', no hyphenated 'rate-limit'.) */
const TRANSIENT_MARKERS = [
  'dns_resolution_failed',
  'fetch failed',
  'socket hang up',
  'connection refused',
  'connection reset',
  'connection closed',
  'network error',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'aborted due to timeout',
  'timed out after',
  'rate limit',
  'too many requests',
] as const;
/** Retryable HTTP status (429/502/503/504) ONLY in a status context - never a bare substring. */
// eslint-disable-next-line security/detect-unsafe-regex -- bounded \D{0,10}; statuses are fixed literals
const HTTP_STATUS_WORD = /\b(?:http|status(?:\s*code)?|code)\b\D{0,10}(?:429|502|503|504)\b/i;
const HTTP_STATUS_PAREN = /[([](?:429|502|503|504)[)\]]/;

function hasTransientHttpStatus(raw: string): boolean {
  return HTTP_STATUS_WORD.test(raw) || HTTP_STATUS_PAREN.test(raw);
}

/**
 * Scanned-API HTTP 5xx (ClientError-shaped). Target failure, not a Dino crash (#197 Part B).
 * `response` is typed unknown — guard the numeric status read; never assume `.status` exists.
 */
export function isUpstreamServerError(err: unknown): boolean {
  if (!isUpstreamClientError(err)) return false;
  const response = err.response;
  if (response === null || typeof response !== 'object') return false;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' && status >= 500 && status < 600;
}

/** Retryable network/DNS/timeout error? Safe against incidental substrings in user/upstream content. */
export function isTransientError(err: unknown): boolean {
  // #197 Part B: scanned-API 5xx → transient (exit 4), never crash (70). Existing 429/502/503/504 path unchanged.
  if (isUpstreamServerError(err)) return true;
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
    if ((err as { name?: unknown }).name === 'AbortError') return true;
  }
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (TRANSIENT_MARKERS.some((m) => lower.includes(m))) return true;
  return hasTransientHttpStatus(raw);
}

/**
 * #201: rewrite endpoint-validation jargon at the CLI boundary.
 * Returns undefined when the message is not an endpoint-validation error.
 */
function humanizeEndpointValidationError(message: string): string | undefined {
  // All engine SSRF/DNS errors carry the literal "SSRF blocked:" prefix + a reason code.
  if (message.includes('SSRF blocked:')) {
    if (message.includes('dns_resolution_failed')) {
      return "We couldn't find that host. Check the endpoint URL for a typo and try again.";
    }
    if (
      message.includes('blocked_ipv4') ||
      message.includes('blocked_ipv6') ||
      message.includes('metadata_host') ||
      message.includes('unparseable_mapped_ip')
    ) {
      return "That endpoint points to a private or internal address, so Dino won't test it. Use a public API endpoint.";
    }
    if (message.includes('wrong_protocol')) {
      return 'The endpoint URL must start with http:// or https://.';
    }
    if (message.includes('malformed_url')) {
      return "That endpoint URL isn't valid. Example: https://api.example.com/graphql";
    }
    // Unknown/future reason code — never leak "SSRF blocked … <code>".
    return "Dino couldn't test that endpoint: it didn't pass an address safety check.";
  }
  return undefined;
}

/** Known node/network failure signatures → product text; undefined when none matches. */
function humanizeNetworkError(haystack: string, name: string, message: string): string | undefined {
  if (haystack.includes('ECONNRESET') || message.includes('socket hang up')) {
    return 'The connection to the API was closed unexpectedly. Check the endpoint and your network.';
  }
  if (haystack.includes('ENOTFOUND')) {
    return "Couldn't resolve the endpoint host. Check the URL.";
  }
  if (haystack.includes('ECONNREFUSED')) {
    return 'The endpoint refused the connection. Is it running and reachable?';
  }
  if (haystack.includes('ETIMEDOUT') || name === 'AbortError' || haystack.includes('AbortError')) {
    return 'The request timed out. The endpoint may be slow or unreachable.';
  }
  if (message.includes('fetch failed')) {
    return "Couldn't reach the endpoint. Check the URL and your network.";
  }
  return undefined;
}

/**
 * #174/#201: map known node/network and endpoint-validation errors to clean product text.
 * Default arm keeps the original `.message` (bounded). Never interpolates the raw error object or
 * `process.env` — map by code/name/message substrings only. This is the ONE place a failure's
 * human message is built (#2196 D5), so the prose and the stderr envelope carry the same words.
 */
export function humanizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  let code = '';
  if (err !== null && typeof err === 'object') {
    const rawCode = Reflect.get(err, 'code');
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
  }
  const haystack = `${code} ${name} ${message}`;

  // #193: single-source with classifyCaughtKind - prefix/class only (not message substring).
  if (isSsrfBlockedError(err)) {
    const endpointMsg = humanizeEndpointValidationError(message);
    if (endpointMsg !== undefined) return endpointMsg;
  }

  // #201: node's own malformed-URL TypeError. Anchor on the stable ERR_INVALID_URL code,
  // not a message substring, so a target API's error text can't false-match.
  if (code === 'ERR_INVALID_URL') {
    return "That endpoint URL isn't valid. Example: https://api.example.com/graphql";
  }
  const network = humanizeNetworkError(haystack, name, message);
  if (network !== undefined) return network;
  return boundErrorMessage(err);
}

/** The one canonical, sanitized failure message both the prose and the envelope render (#2196 D5). */
export function canonicalFailureMessage(err: unknown): string {
  return sanitizeErrorMessage(humanizeError(err));
}

/** Classify a watch/iteration failure through the canonical caught-error path. */
export function outcomeKindFromIterationError(err: unknown): OutcomeKind {
  return outcomeFromCaughtError(err).kind;
}

const RESULT_ONLY_KINDS = new Set<OutcomeKind>(['clean', 'findings_below', 'policy', 'partial']);

function classifyCaughtKind(err: unknown): OutcomeKind {
  // Every CliError declares its honest kind (required since #2173's error-contract migration).
  if (err instanceof CliError) return err.kind;
  // A DinoError carries a stable code; the contract table decides its CLI kind (never message text).
  // A code with no CLI projection (null) is one no CLI path should raise; reaching it is a CLI defect, so it
  // is `crash` rather than a guessed kind. The envelope still carries the code and its table retryability.
  if (err instanceof DinoError) return errorContractFor(err.code).cliKind ?? 'crash';
  // #193: a raw SSRF/DNS block is usage, before the transient heuristics.
  if (isSsrfBlockedError(err)) return 'usage';
  if (isTenantConfigError(err)) return err.kind;
  return isTransientError(err) ? 'transient' : 'crash';
}

function retryableForCaught(kind: OutcomeKind, err: unknown): 'transient' | 'permanent' {
  // A DinoError's retryability is the table's, per code — never inferred from its CLI kind.
  if (err instanceof DinoError)
    return errorContractFor(err.code).retryable ? 'transient' : 'permanent';
  if (kind === 'transient') return 'transient';
  if (err instanceof CliError) return err.retryable;
  return 'permanent';
}

/** The stable Dino code for a caught error, when it has one. */
function codeForCaught(err: unknown): DinoErrorCode | undefined {
  if (err instanceof DinoError) return err.code;
  if (isTenantConfigError(err)) return err.code;
  if (err instanceof CliError) return err.code;
  return undefined;
}

/**
 * Map a caught error to a RuntimeOutcome.
 * Explicit CliError.kind wins; kindless/raw classify via isTransientError;
 * result-only kinds are forced to crash (a throw is never a success RESULT).
 */
export function outcomeFromCaughtError(err: unknown): RuntimeOutcome {
  let kind = classifyCaughtKind(err);

  // Guard: a caught error is a failure - never resolve to envelope-less result codes.
  if (RESULT_ONLY_KINDS.has(kind)) {
    kind = 'crash';
  }

  // Inferred/explicit transient must carry retryable:'transient' (override CliError permanent default).
  const retryable = retryableForCaught(kind, err);

  const error: RuntimeOutcomeError = {
    kind,
    // D5: the canonical, humanized message — the same words the prose renders.
    message: canonicalFailureMessage(err),
    retryable,
  };
  const code = codeForCaught(err);
  if (code !== undefined) error.code = code;
  if (err instanceof CliError && err.hint !== undefined) {
    error.suggestion = err.hint;
  }
  if (hasNextAction(err)) {
    error.nextAction = err.nextAction;
  }
  return { kind, error };
}
