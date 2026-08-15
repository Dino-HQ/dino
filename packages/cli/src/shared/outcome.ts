/**
 * @dino/cli — permanent exit-code contract + error envelope (#2173).
 * Normative: output-observability-contract.md §5A.2 / §5A.7.
 */

import { sanitizeErrorMessage } from '@dino/core';
import { CliError } from './errors';
import { stripControlsAndAnsi } from './neutralize';

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

export type OutcomeKind =
  | 'clean'
  | 'findings_below'
  | 'policy'
  | 'partial'
  | 'transient'
  | 'usage'
  | 'config'
  | 'crash';

export interface RuntimeOutcomeError {
  kind: string;
  message: string;
  retryable: 'transient' | 'permanent';
  input?: unknown;
  suggestion?: string;
}

export interface RuntimeOutcome {
  kind: OutcomeKind;
  /** Concurrent kinds; highest-precedence kind wins (INV precedence). */
  also?: readonly OutcomeKind[];
  /** `--accept-partial` downgrades a winning `partial` to exit 0 (INV-1). */
  acceptPartial?: boolean;
  error?: RuntimeOutcomeError;
}

/** Highest precedence first: crash wins over everything. */
const PRECEDENCE: readonly OutcomeKind[] = [
  'crash',
  'config',
  'usage',
  'transient',
  'policy',
  'partial',
  'clean',
  'findings_below',
];

const EXIT_CODE = new Map<OutcomeKind, number>([
  ['clean', 0],
  ['findings_below', 0],
  ['policy', 3],
  ['partial', 6],
  ['transient', 4],
  ['usage', 2],
  ['config', 5],
  ['crash', 70],
]);

const ENVELOPE_EXIT_CODES = new Set([2, 4, 5, 70]);

function winningKind(o: RuntimeOutcome): OutcomeKind {
  const kinds = [o.kind, ...(o.also ?? [])];
  let best = kinds[0] ?? 'clean';
  let bestRank = PRECEDENCE.indexOf(best);
  for (const k of kinds) {
    const rank = PRECEDENCE.indexOf(k);
    if (rank >= 0 && (bestRank < 0 || rank < bestRank)) {
      best = k;
      bestRank = rank;
    }
  }
  return best;
}

/** Pure: outcome → contract exit code (§5A.7). */
export function resolveExitCode(o: RuntimeOutcome): number {
  const winner = winningKind(o);
  if (winner === 'partial' && o.acceptPartial === true) return 0;
  return EXIT_CODE.get(winner) ?? 70;
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
  if (err.input !== undefined) body.input = sanitizeInput(err.input);
  if (err.suggestion !== undefined) body.suggestion = sanitizeErrorMessage(err.suggestion);
  return JSON.stringify({ error: body });
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

/** Retryable network/DNS/timeout error? Safe against incidental substrings in user/upstream content. */
export function isTransientError(err: unknown): boolean {
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

/** Classify a watch/iteration failure as transient (4) vs crash (70). */
export function outcomeKindFromIterationError(err: unknown): OutcomeKind {
  if (err instanceof CliError && err.kind !== undefined) return err.kind;
  return isTransientError(err) ? 'transient' : 'crash';
}

function kindFromExitCode(exitCode: number): OutcomeKind {
  switch (exitCode) {
    case 2:
      return 'usage';
    case 3:
      return 'policy';
    case 4:
      return 'transient';
    case 5:
      return 'config';
    case 6:
      return 'partial';
    case 70:
      return 'crash';
    default:
      // Bare/legacy `1` and unknown codes collapse to the crash floor.
      return 'crash';
  }
}

const RESULT_ONLY_KINDS = new Set<OutcomeKind>(['clean', 'findings_below', 'policy', 'partial']);

function classifyCaughtKind(err: unknown): OutcomeKind {
  if (err instanceof CliError) {
    if (err.kind !== undefined) return err.kind;
    if (err.exitCode !== 1) return kindFromExitCode(err.exitCode);
  }
  return isTransientError(err) ? 'transient' : 'crash';
}

function retryableForCaught(kind: OutcomeKind, err: unknown): 'transient' | 'permanent' {
  if (kind === 'transient') return 'transient';
  if (err instanceof CliError) return err.retryable;
  return 'permanent';
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
    message: sanitizeErrorMessage(boundErrorMessage(err)),
    retryable,
  };
  if (err instanceof CliError && err.hint !== undefined) {
    error.suggestion = err.hint;
  }
  return { kind, error };
}
