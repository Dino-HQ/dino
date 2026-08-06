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
  // Rate limit (429)
  | 'RATE_LIMITED'
  // Service unavailable (503)
  | 'SERVICE_UNAVAILABLE'
  // Quota (402)
  | 'QUOTA_EXCEEDED'
  // Upstream (502)
  | 'UPSTREAM_FAILED'
  | 'STYTCH_ERROR'
  | 'GCP_ERROR'
  | 'INNGEST_ERROR'
  | 'OIDC_DISCOVERY_FAILED'
  | 'OAUTH2_EXCHANGE_FAILED'
  | 'OAUTH2_RECONNECT_FAILED'
  // Internal (500)
  | 'INTERNAL_ERROR'
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
  statusCode?: number;
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
    this.statusCode = opts.statusCode ?? 500; // masked-fix:allowed — base class default, was `= 500` param default before options refactor
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
  toJSON(): {
    error: {
      code: DinoErrorCode;
      message: string;
      status: number;
      feature?: string;
      limit?: number | null;
      used?: number;
      resetDate?: string | null;
      allowedLevels?: readonly string[];
    };
  } {
    const error: {
      code: DinoErrorCode;
      message: string;
      status: number;
      feature?: string;
      limit?: number | null;
      used?: number;
      resetDate?: string | null;
      allowedLevels?: readonly string[];
    } = {
      code: this.code,
      message: this.message,
      status: this.statusCode,
    };
    if (
      (this.code === 'QUOTA_EXCEEDED' || this.code === 'TIER_UPGRADE_REQUIRED') &&
      this.meta !== undefined
    ) {
      const m = this.meta;
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
    return { error };
  }
}

// ── Narrowed code types per subclass ────────────────────────
// Prevents DinoValidationError('STYTCH_ERROR') — code must match the
// HTTP status family the subclass represents.

/** Codes valid for 400-class errors. */
export type ValidationErrorCode = Extract<
  DinoErrorCode,
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
>;

/** Codes valid for 401/403-class errors. */
export type AuthErrorCode = Extract<
  DinoErrorCode,
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'AUTH_FORBIDDEN'
  | 'LAST_OWNER'
  | 'DOMAIN_NOT_VERIFIED'
>;

/** Codes valid for 404-class errors. */
export type NotFoundErrorCode = Extract<
  DinoErrorCode,
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
>;

/** Codes valid for 409-class errors. */
export type ConflictErrorCode = Extract<
  DinoErrorCode,
  | 'ALREADY_EXISTS'
  | 'STATE_CONFLICT'
  | 'RETRY_LIMIT_EXCEEDED'
  | 'API_CONTEXT_SNAPSHOT_NOT_COMPLETE'
  | 'SNAPSHOT_VERSION_UNSUPPORTED'
>;

/** Codes valid for 502-class errors. */
export type UpstreamErrorCode = Extract<
  DinoErrorCode,
  | 'UPSTREAM_FAILED'
  | 'STYTCH_ERROR'
  | 'GCP_ERROR'
  | 'INNGEST_ERROR'
  | 'OIDC_DISCOVERY_FAILED'
  | 'OAUTH2_EXCHANGE_FAILED'
  | 'OAUTH2_RECONNECT_FAILED'
>;

// ── Subclasses ──────────────────────────────────────────────

/** 400 — bad input from the client. */
export class DinoValidationError extends DinoError {
  constructor(
    code: ValidationErrorCode,
    message: string,
    meta?: ErrorMeta | undefined,
    options?: { cause?: unknown },
  ) {
    super({ code, message, statusCode: 400, meta, cause: options?.cause });
    this.name = 'DinoValidationError';
  }
}

/** 401/403 — authentication or authorization failure. */
export class DinoAuthError extends DinoError {
  constructor(
    code: AuthErrorCode,
    message: string,
    statusCode: 401 | 403 = 401,
    options?: { cause?: unknown },
  ) {
    super({ code, message, statusCode, cause: options?.cause });
    this.name = 'DinoAuthError';
  }
}

/** 404 — resource not found. */
export class DinoNotFoundError extends DinoError {
  constructor(code: NotFoundErrorCode, message: string, meta?: ErrorMeta | undefined) {
    super({ code, message, statusCode: 404, meta });
    this.name = 'DinoNotFoundError';
  }
}

/** 409 — state conflict (wrong status for operation, retry exhausted). */
export class DinoConflictError extends DinoError {
  constructor(code: ConflictErrorCode, message: string, meta?: ErrorMeta | undefined) {
    super({ code, message, statusCode: 409, meta });
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
    super({ code, message, statusCode: 502, meta, cause: options?.cause });
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
