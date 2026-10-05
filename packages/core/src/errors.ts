/**
 * Dino Error Hierarchy — typed, structured, serializable.
 *
 * Design:
 * - Hypothesis-inspired: small hierarchy (6 classes), code enum for
 *   exhaustive switch, instanceof for broad catches, cause chain preserved.
 * - Stripe-inspired: .code for programmatic switching, .meta for structured
 *   context, .toJSON() for API serialization.
 * - Maciver's rules: never hide exceptions, one error per condition,
 *   never remove information when wrapping.
 *
 * The 6 classes map to HTTP status families:
 *   DinoError (base)           — any status
 *   DinoValidationError        — 400
 *   DinoAuthError              — 401/403
 *   DinoNotFoundError          — 404
 *   DinoConflictError          — 409
 *   DinoUpstreamError          — 502
 */

import { ERROR_CONTRACT } from './error-contract';
import { parseCredentialNextAction, type CredentialNextAction } from './credential-next-action';

// ── Error codes ─────────────────────────────────────────────

/** All Dino error codes. Exhaustive, grepable, stable contract. */
export type DinoErrorCode =
  // Validation (400)
  | 'INVALID_JSON'
  | 'INVALID_REQUEST_BODY'
  | 'INVALID_FIELD'
  | 'INVALID_SPEC_BODY'
  | 'PROTOCOL_NOT_SUPPORTED'
  | 'CONFIG_INVALID'
  | 'API_CONTEXT_SNAPSHOT_INVALID_ID'
  | 'OIDC_ISSUER_MISMATCH'
  | 'FEATURE_DISABLED'
  | 'OAUTH2_NO_REFRESH_TOKEN'
  // Payload (413)
  | 'PAYLOAD_TOO_LARGE'
  // Auth (401/403)
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'AUTH_FORBIDDEN'
  | 'LAST_OWNER'
  | 'DOMAIN_NOT_VERIFIED'
  | 'TIER_UPGRADE_REQUIRED'
  // Not found (404)
  | 'TENANT_NOT_FOUND'
  | 'SCAN_NOT_FOUND'
  | 'RUNNER_NOT_FOUND'
  | 'DCG_NOT_FOUND'
  | 'RESOURCE_NOT_FOUND'
  | 'MEMBER_NOT_FOUND'
  | 'API_CONTEXT_SNAPSHOT_NOT_FOUND'
  | 'API_CONTEXT_NO_COMPLETE_SNAPSHOT'
  | 'NO_SNAPSHOT'
  | 'INSUFFICIENT_SCANS'
  // Conflict (409)
  | 'ALREADY_EXISTS'
  | 'STATE_CONFLICT'
  | 'RETRY_LIMIT_EXCEEDED'
  | 'API_CONTEXT_SNAPSHOT_NOT_COMPLETE'
  | 'SNAPSHOT_VERSION_UNSUPPORTED'
  // Idempotency (409) — a Bootstrap Request identity (principal+org+action+key) was reused with
  // DIFFERENT normalized request semantics. Per ADR-0056 (Idempotency Identity), "same key + different
  // semantics" is a typed conflict, never a silent last-write-win or a new canonical version. Distinct
  // from ALREADY_EXISTS (a canonical artifact with that name already exists under a *different* request).
  | 'IDEMPOTENCY_CONFLICT'
  // Continuation (409) — a Human Action Request submission or resume names a checkpoint that is no longer
  // the Request's current one, or a Request that cannot continue (DIN-1354). Re-read the Request.
  | 'CHECKPOINT_INVALID'
  // Continuation (409) — the Human Action Request expired before a response was accepted (DIN-1354).
  | 'CHECKPOINT_EXPIRED'
  // Agent Proxy (409): a mutating dispatch with this identity already completed once. The action
  // landed; only its response is non-replayable. Not retryable, and not ambiguous.
  | 'DISPATCH_ALREADY_RESOLVED'
  // Credential Reference outcomes (P1F / DIN-1353) — typed, fail-closed, each with a bounded
  // `nextAction` (see credential-outcome.ts). NOT_FOUND is 404 (existence-hiding); the rest 409/503.
  | 'CREDENTIAL_REFERENCE_NOT_FOUND'
  | 'CREDENTIAL_REFERENCE_REVOKED'
  | 'CREDENTIAL_REFERENCE_STALE'
  | 'CREDENTIAL_RESIDENCY_MISMATCH'
  | 'CREDENTIAL_RECONFIGURE_REQUIRED'
  | 'CREDENTIAL_CUSTODY_UNAVAILABLE'
  // A static Authentication Identity with no stored credential yet (DIN-1493): provide one through a handoff.
  | 'CREDENTIAL_REQUIRED'
  // Credential handoff outcomes (P1L / DIN-1493) — see credential-handoff-outcome.ts. NOT_FOUND is 404
  // (existence-hiding across Organizations and for a link that is not the handoff's current one); the rest 409.
  | 'CREDENTIAL_HANDOFF_NOT_FOUND'
  | 'CREDENTIAL_HANDOFF_LINK_EXPIRED'
  | 'CREDENTIAL_HANDOFF_CLOSED'
  // Target Connection outcomes (DIN-1490) — typed, fail-closed, each with a bounded `nextAction` (see
  // target-connection-outcome.ts). SCOPE_INVALID is 400; the rest are 409.
  | 'TARGET_CONNECTION_REQUIRED'
  | 'TARGET_CONNECTION_NOT_AUTHORIZED'
  | 'TARGET_CONNECTION_STALE'
  | 'TARGET_CONNECTION_SCOPE_INVALID'
  | 'TARGET_CONNECTION_SCOPE_UNAVAILABLE'
  // Authentication Flow outcomes (DIN-1492) — admission refusals are 400; a missing admitted version is 409.
  | 'AUTH_FLOW_INVALID'
  | 'AUTH_FLOW_UNSAFE'
  | 'AUTH_FLOW_NOT_ADMITTED'
  // Scan execution outcomes (DIN-1503/1504/1505/1506) — why an attempt could not run or failed, each with a bounded
  // `nextAction` (see scan-failure.ts). API_SPEC_REQUIRED is also the 409 at scan admission.
  | 'SCAN_API_SPEC_REQUIRED'
  | 'SCAN_API_SPEC_UNAVAILABLE'
  | 'SCAN_DISCOVERY_FAILED'
  | 'SCAN_RUNNER_UNAVAILABLE'
  | 'SCAN_RUNNER_FAILED'
  // Billing handoff outcomes (DIN-1357) — each with a bounded `nextAction` (see billing-outcome.ts).
  | 'BILLING_PROVIDER_UNAVAILABLE'
  | 'BILLING_PROVIDER_NOT_CONFIGURED'
  | 'BILLING_PROVIDER_REJECTED'
  | 'BILLING_CUSTOMER_NOT_FOUND'
  | 'BILLING_RETURN_URL_NOT_ALLOWED'
  | 'BILLING_CHECKOUT_OUTCOME_UNKNOWN'
  | 'BILLING_SUBSCRIPTION_EXISTS'
  // Rate limit (429)
  | 'RATE_LIMITED'
  // Upstream/provider rate limit (429) — the SECRET CUSTODIAN throttled Dino (distinct from
  // `RATE_LIMITED`, which is Dino throttling the tenant). Same HTTP status, separable source (F01c AC5).
  | 'PROVIDER_RATE_LIMITED'
  // Service unavailable (503)
  | 'SERVICE_UNAVAILABLE'
  // Quota (402)
  | 'QUOTA_EXCEEDED'
  // Upstream (502)
  | 'UPSTREAM_FAILED'
  | 'STYTCH_ERROR'
  | 'GCP_ERROR'
  | 'OIDC_DISCOVERY_FAILED'
  | 'OAUTH2_EXCHANGE_FAILED'
  // Agent Proxy (502): a mutating dispatch may or may not have run (lost response, or a same-key
  // retry of an in-flight intent). NEVER retry blindly — a resend can duplicate a non-idempotent
  // effect. `reason` (lost_response | already_dispatched) is serialized; see DispatchAmbiguousReason.
  | 'DISPATCH_AMBIGUOUS'
  // Method not allowed (405)
  | 'METHOD_NOT_ALLOWED'
  // Unsupported media type (415) — the request body's Content-Type isn't one the endpoint accepts.
  | 'UNSUPPORTED_MEDIA_TYPE'
  // Internal (500)
  | 'INTERNAL_ERROR'
  // Server misconfigured (500) — a Dino deployment is missing required configuration (a secret, an
  // app ID). The caller can't fix it; distinct from CONFIG_INVALID (the caller's configuration, 400).
  | 'SERVER_MISCONFIGURED'
  // Engine / pipeline
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'CIRCUIT_OPEN';

/** Structured metadata bag for error context. */
export type ErrorMeta = Record<string, unknown>;

// ── Base class ──────────────────────────────────────────────

/** Options for constructing a DinoError. */
export interface DinoErrorOptions {
  code: DinoErrorCode;
  message: string;
  meta?: ErrorMeta | undefined;
  cause?: unknown;
}

/**
 * Base error for all Dino domain errors.
 *
 * Carries a stable `code` (for programmatic handling), HTTP `statusCode`
 * (for API responses), optional structured `meta` (for context like IDs),
 * and optional `cause` chain (ES2022 — never lose the original error).
 */
export class DinoError extends Error {
  public readonly code: DinoErrorCode;
  public readonly statusCode: number;
  public readonly meta?: ErrorMeta | undefined;

  constructor(opts: DinoErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = opts.code;
    // The status is the code's, never the caller's: ERROR_CONTRACT is the only source. Engine-only codes
    // (status null) never reach an HTTP response and report 500 if one ever does.
    this.statusCode = ERROR_CONTRACT[opts.code].status ?? 500; // masked-fix:allowed — engine-only codes have no HTTP status
    this.meta = opts.meta;
    this.name = 'DinoError';
  }

  /**
   * Client-safe JSON for API responses.
   * meta is intentionally excluded — it may contain IDs, field names, or
   * diagnostic context that should stay in server logs, not leak to clients.
   * Clients switch on `error.code`; logs use `error.meta` via the error handler.
   *
   * Exception — UPGRADE CONTEXT (C14, contract #1259): the two entitlement-denial
   * codes (`QUOTA_EXCEEDED`, `TIER_UPGRADE_REQUIRED`) surface a fixed WHITELIST of
   * meta fields so the client can build a precise upgrade deep-link
   * (`feature`, `limit`, `used`, `resetDate`, `allowedLevels`). ONLY these keys are
   * ever copied — never the whole meta bag, so IDs/diagnostics stay server-side.
   */
  toJSON(): { error: DinoErrorJson } {
    const error: DinoErrorJson = {
      code: this.code,
      message: this.message,
      status: this.statusCode,
      retryable: ERROR_CONTRACT[this.code].retryable,
    };
    if (
      (this.code === 'QUOTA_EXCEEDED' || this.code === 'TIER_UPGRADE_REQUIRED') &&
      this.meta !== undefined
    ) {
      copyUpgradeContext(this.meta, error);
    }
    // P1F (DIN-1353), DIN-1490: credential and Target Connection outcomes surface ONLY a validated,
    // closed-union NextAction — never the rest of meta. An unrecognised shape is dropped (fail closed).
    if (hasBoundedNextAction(this.code) && this.meta !== undefined) {
      const nextAction = parseCredentialNextAction(this.meta.nextAction);
      if (nextAction !== undefined) error.nextAction = nextAction;
    }
    // Agent Proxy: an ambiguous dispatch surfaces ONLY its closed-union reason, which callers need
    // to tell a lost response from a refused same-key retry. Anything else in meta stays server-side.
    if (this.code === 'DISPATCH_AMBIGUOUS' && isDispatchAmbiguousReason(this.meta?.reason)) {
      error.reason = this.meta.reason;
    }
    return { error };
  }
}

/** Client-safe error body. `meta` never serializes wholesale — only the whitelisted fields below. */
export interface DinoErrorJson {
  code: DinoErrorCode;
  message: string;
  status: number;
  /** Whether sending the same request again, unchanged, can succeed (from ERROR_CONTRACT). */
  retryable: boolean;
  feature?: string;
  limit?: number | null;
  used?: number;
  resetDate?: string | null;
  allowedLevels?: readonly string[];
  nextAction?: CredentialNextAction;
  reason?: DispatchAmbiguousReason;
}

/** Why an Agent Proxy mutating dispatch is ambiguous. */
export type DispatchAmbiguousReason = 'lost_response' | 'already_dispatched';

function isDispatchAmbiguousReason(value: unknown): value is DispatchAmbiguousReason {
  return value === 'lost_response' || value === 'already_dispatched';
}

const SCAN_OUTCOME_CODES: ReadonlySet<DinoErrorCode> = new Set<DinoErrorCode>([
  'SCAN_API_SPEC_REQUIRED',
  'SCAN_API_SPEC_UNAVAILABLE',
  'SCAN_DISCOVERY_FAILED',
  'SCAN_RUNNER_UNAVAILABLE',
  'SCAN_RUNNER_FAILED',
]);

/** Codes whose body may carry the closed-union bounded `nextAction` (credential, Connection, flow, scan, billing and entitlement outcomes). */
function hasBoundedNextAction(code: DinoErrorCode): boolean {
  return (
    code.startsWith('CREDENTIAL_') ||
    code.startsWith('BILLING_') ||
    code === 'QUOTA_EXCEEDED' ||
    code === 'TIER_UPGRADE_REQUIRED' ||
    code.startsWith('TARGET_CONNECTION_') ||
    code.startsWith('AUTH_FLOW_') ||
    SCAN_OUTCOME_CODES.has(code)
  );
}

const UPGRADE_CONTEXT_FIELDS = ['feature', 'limit', 'used', 'resetDate', 'allowedLevels'] as const;

/**
 * The fields beyond `code`, `message`, `status` and `retryable` a code's error body may carry — the same
 * whitelist `toJSON()` applies. The OpenAPI error schema is generated from it.
 */
export function errorBodyExtraFields(code: DinoErrorCode): readonly (keyof DinoErrorJson)[] {
  if (code === 'QUOTA_EXCEEDED' || code === 'TIER_UPGRADE_REQUIRED') {
    return [...UPGRADE_CONTEXT_FIELDS, 'nextAction'];
  }
  if (hasBoundedNextAction(code)) return ['nextAction'];
  if (code === 'DISPATCH_AMBIGUOUS') return ['reason'];
  return [];
}

/** UPGRADE CONTEXT (C14, contract #1259): copy ONLY the fixed whitelist of typed meta fields. */
function copyUpgradeContext(m: ErrorMeta, error: DinoErrorJson): void {
  if (typeof m.feature === 'string') {
    error.feature = m.feature;
  }
  if (typeof m.used === 'number') {
    error.used = m.used;
  }
  if (typeof m.limit === 'number' || m.limit === null) {
    error.limit = m.limit;
  }
  if (typeof m.resetDate === 'string' || m.resetDate === null) {
    error.resetDate = m.resetDate;
  }
  if (Array.isArray(m.allowedLevels)) {
    // Validate every element (not just Array.isArray) so a non-string array never
    // leaks mistyped to the client — parity with the typed checks above. The old
    // `as readonly string[]` cast let e.g. `[{ tenantId }]` through as `string[]`.
    error.allowedLevels = m.allowedLevels.filter((x): x is string => typeof x === 'string');
  }
}

// ── Narrowed code types per subclass ────────────────────────
// Prevents DinoValidationError('STYTCH_ERROR') — code must match the
// HTTP status family the subclass represents.

/** Codes valid for 400-class errors. */
export const VALIDATION_ERROR_CODES = [
  'INVALID_JSON',
  'INVALID_REQUEST_BODY',
  'INVALID_FIELD',
  'INVALID_SPEC_BODY',
  'PROTOCOL_NOT_SUPPORTED',
  'CONFIG_INVALID',
  'API_CONTEXT_SNAPSHOT_INVALID_ID',
  'OIDC_ISSUER_MISMATCH',
  'FEATURE_DISABLED',
  'OAUTH2_NO_REFRESH_TOKEN',
] as const satisfies readonly DinoErrorCode[];
export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];

/** Codes valid for 401/403-class errors. */
export const AUTH_ERROR_CODES = [
  'AUTH_MISSING',
  'AUTH_INVALID',
  'AUTH_EXPIRED',
  'AUTH_FORBIDDEN',
  'LAST_OWNER',
  'DOMAIN_NOT_VERIFIED',
] as const satisfies readonly DinoErrorCode[];
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** Codes valid for 404-class errors. */
export const NOT_FOUND_ERROR_CODES = [
  'TENANT_NOT_FOUND',
  'SCAN_NOT_FOUND',
  'RUNNER_NOT_FOUND',
  'DCG_NOT_FOUND',
  'RESOURCE_NOT_FOUND',
  'MEMBER_NOT_FOUND',
  'API_CONTEXT_SNAPSHOT_NOT_FOUND',
  'API_CONTEXT_NO_COMPLETE_SNAPSHOT',
  'NO_SNAPSHOT',
  'INSUFFICIENT_SCANS',
] as const satisfies readonly DinoErrorCode[];
export type NotFoundErrorCode = (typeof NOT_FOUND_ERROR_CODES)[number];

/** Codes valid for 409-class errors. */
export const CONFLICT_ERROR_CODES = [
  'ALREADY_EXISTS',
  'STATE_CONFLICT',
  'RETRY_LIMIT_EXCEEDED',
  'API_CONTEXT_SNAPSHOT_NOT_COMPLETE',
  'SNAPSHOT_VERSION_UNSUPPORTED',
  'IDEMPOTENCY_CONFLICT',
  'DISPATCH_ALREADY_RESOLVED',
  'CHECKPOINT_INVALID',
  'CHECKPOINT_EXPIRED',
] as const satisfies readonly DinoErrorCode[];
export type ConflictErrorCode = (typeof CONFLICT_ERROR_CODES)[number];

/** Codes valid for 502-class errors. */
export const UPSTREAM_ERROR_CODES = [
  'UPSTREAM_FAILED',
  'STYTCH_ERROR',
  'GCP_ERROR',
  'OIDC_DISCOVERY_FAILED',
  'OAUTH2_EXCHANGE_FAILED',
  'DISPATCH_AMBIGUOUS',
] as const satisfies readonly DinoErrorCode[];
export type UpstreamErrorCode = (typeof UPSTREAM_ERROR_CODES)[number];

// ── Subclasses ──────────────────────────────────────────────

/** 400 — bad input from the client. */
export class DinoValidationError extends DinoError {
  constructor(
    code: ValidationErrorCode,
    message: string,
    meta?: ErrorMeta | undefined,
    options?: { cause?: unknown },
  ) {
    super({ code, message, meta, cause: options?.cause });
    this.name = 'DinoValidationError';
  }
}

/** 401/403 — authentication or authorization failure. */
export class DinoAuthError extends DinoError {
  constructor(code: AuthErrorCode, message: string, options?: { cause?: unknown }) {
    super({ code, message, cause: options?.cause });
    this.name = 'DinoAuthError';
  }
}

/** 404 — resource not found. */
export class DinoNotFoundError extends DinoError {
  constructor(code: NotFoundErrorCode, message: string, meta?: ErrorMeta | undefined) {
    super({ code, message, meta });
    this.name = 'DinoNotFoundError';
  }
}

/** 409 — state conflict (wrong status for operation, retry exhausted). */
export class DinoConflictError extends DinoError {
  constructor(code: ConflictErrorCode, message: string, meta?: ErrorMeta | undefined) {
    super({ code, message, meta });
    this.name = 'DinoConflictError';
  }
}

/** 502 — upstream service failure (Stytch, GCP, Inngest). */
export class DinoUpstreamError extends DinoError {
  constructor(
    code: UpstreamErrorCode,
    message: string,
    meta?: ErrorMeta | undefined,
    options?: { cause?: unknown },
  ) {
    super({ code, message, meta, cause: options?.cause });
    this.name = 'DinoUpstreamError';
  }
}

// ── Error class taxonomy bridge ─────────────────────────────
// The engine error-classifier uses ErrorClass (8 coarse categories for
// retry decisions). DinoErrorCode uses specific codes for client-facing
// responses. This mapping bridges them for analytics and dashboard display.

/**
 * Coarse error classification used by the engine pipeline for retry and
 * circuit-breaker decisions. Defined here so both engine and cloud can
 * reference the same type without circular imports.
 */
export type ErrorClass =
  | 'TIMEOUT'
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'VALIDATION'
  | 'BUDGET'
  | 'PERMANENT'
  | 'UNKNOWN';

/**
 * Map an engine ErrorClass to the closest DinoErrorCode.
 *
 * Lossy by design — ErrorClass is coarser than DinoErrorCode.
 * Use when translating pipeline tool records into structured error
 * reports for the cloud dashboard.
 */
export function errorClassToCode(errorClass: ErrorClass): DinoErrorCode {
  switch (errorClass) {
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'NETWORK':
      return 'NETWORK_ERROR';
    case 'RATE_LIMIT':
      return 'RATE_LIMITED';
    case 'AUTH':
      return 'AUTH_INVALID';
    case 'VALIDATION':
      return 'INVALID_REQUEST_BODY';
    case 'BUDGET':
      return 'BUDGET_EXCEEDED';
    case 'PERMANENT':
      return 'INTERNAL_ERROR';
    case 'UNKNOWN':
      return 'INTERNAL_ERROR';
  }
}
