/**
 * @dino/core — the Dino error contract: one row per DinoErrorCode.
 *
 * The same underlying condition carries the same meaning on every transport. HTTP, the CLI and MCP
 * frame a failure differently (status, exit code, tool result) but read its meaning from here:
 *
 * - `status`    — the HTTP status the code is sent with (`null` for engine-internal codes that never
 *                 reach an HTTP response). Subclass defaults and literal `statusCode`s must agree.
 * - `retryable` — whether retrying the same request, unchanged, can succeed. Part of the code's canonical
 *                 meaning, decided per code — never from the status family (502 holds both provider outages
 *                 and permanent refusals) and never from the CLI projection below.
 * - `cliKind`   — the CLI's projection: the outcome kind (and so exit code) when this error ends a command.
 *                 Only the four error kinds are allowed (the CLI turns a thrown result-only kind into
 *                 `crash`). `null` means no CLI outcome honestly represents the condition and no CLI path
 *                 raises it; mapping one is a CLI decision, never a reason to bend the row.
 *
 * `satisfies Record<DinoErrorCode, …>` makes a new code without a row a compile error.
 */

import type { DinoErrorCode } from './errors';

/** CLI outcome kinds a thrown error may end in. Result-only kinds (clean, findings_below, policy, partial) are excluded. */
export type ErrorCliKind = 'usage' | 'config' | 'transient' | 'crash';

export interface ErrorContractEntry {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly cliKind: ErrorCliKind | null;
}

const usage = (status: number): ErrorContractEntry => ({ status, retryable: false, cliKind: 'usage' });
const config = (status: number | null): ErrorContractEntry => ({ status, retryable: false, cliKind: 'config' });
const transient = (status: number | null): ErrorContractEntry => ({ status, retryable: true, cliKind: 'transient' });

export const ERROR_CONTRACT = {
  // 400 — the request as sent can't succeed; fix the input.
  INVALID_JSON: usage(400),
  INVALID_REQUEST_BODY: usage(400),
  INVALID_FIELD: usage(400),
  INVALID_SPEC_BODY: usage(400),
  PROTOCOL_NOT_SUPPORTED: usage(400),
  API_CONTEXT_SNAPSHOT_INVALID_ID: usage(400),
  // 400 — configuration, not a single request, needs to change.
  CONFIG_INVALID: config(400),
  OIDC_ISSUER_MISMATCH: config(400),
  FEATURE_DISABLED: config(400),
  OAUTH2_NO_REFRESH_TOKEN: config(400),
  // 405 / 413 / 415
  METHOD_NOT_ALLOWED: usage(405),
  PAYLOAD_TOO_LARGE: usage(413),
  UNSUPPORTED_MEDIA_TYPE: usage(415),
  // 401 / 403 — credentials or authorization need attention.
  AUTH_MISSING: config(401),
  AUTH_INVALID: config(401),
  AUTH_EXPIRED: config(401),
  AUTH_FORBIDDEN: config(403),
  DOMAIN_NOT_VERIFIED: config(403),
  LAST_OWNER: usage(403),
  // 402 / 403 — entitlement.
  QUOTA_EXCEEDED: config(402),
  TIER_UPGRADE_REQUIRED: config(403),
  // 404 — the named thing doesn't exist (or isn't visible).
  TENANT_NOT_FOUND: usage(404),
  SCAN_NOT_FOUND: usage(404),
  RUNNER_NOT_FOUND: usage(404),
  DCG_NOT_FOUND: usage(404),
  RESOURCE_NOT_FOUND: usage(404),
  MEMBER_NOT_FOUND: usage(404),
  API_CONTEXT_SNAPSHOT_NOT_FOUND: usage(404),
  API_CONTEXT_NO_COMPLETE_SNAPSHOT: usage(404),
  NO_SNAPSHOT: usage(404),
  INSUFFICIENT_SCANS: usage(404),
  // 409 — current state rules the request out; a blind retry won't change that.
  ALREADY_EXISTS: usage(409),
  STATE_CONFLICT: usage(409),
  RETRY_LIMIT_EXCEEDED: usage(409),
  SNAPSHOT_VERSION_UNSUPPORTED: usage(409),
  IDEMPOTENCY_CONFLICT: usage(409),
  DISPATCH_ALREADY_RESOLVED: usage(409),
  CHECKPOINT_INVALID: usage(409),
  CHECKPOINT_EXPIRED: usage(409),
  // 409 — the snapshot is still being built; the same request succeeds later.
  API_CONTEXT_SNAPSHOT_NOT_COMPLETE: transient(409),
  // Credential Reference outcomes (see credential-outcome.ts for their nextAction).
  CREDENTIAL_REFERENCE_NOT_FOUND: config(404),
  CREDENTIAL_REFERENCE_REVOKED: config(409),
  CREDENTIAL_REFERENCE_STALE: transient(409),
  CREDENTIAL_RESIDENCY_MISMATCH: config(409),
  CREDENTIAL_RECONFIGURE_REQUIRED: config(409),
  CREDENTIAL_CUSTODY_UNAVAILABLE: transient(503),
  // Target Connection outcomes (see target-connection-outcome.ts for their nextAction).
  TARGET_CONNECTION_REQUIRED: config(409),
  TARGET_CONNECTION_NOT_AUTHORIZED: config(409),
  TARGET_CONNECTION_STALE: config(409),
  TARGET_CONNECTION_SCOPE_INVALID: usage(400),
  TARGET_CONNECTION_SCOPE_UNAVAILABLE: config(409),
  // 429 / 503 — try again later.
  RATE_LIMITED: transient(429),
  PROVIDER_RATE_LIMITED: transient(429),
  SERVICE_UNAVAILABLE: transient(503),
  // 502 — a provider Dino depends on could not be reached, timed out, or answered 408/429/5xx; retrying can
  // succeed. Every provider's transport failure uses this one code (packages/cloud/src/lib/provider-failure.ts).
  UPSTREAM_FAILED: transient(502),
  // 502 — the named provider refused the request or answered with something unusable; retrying the same request
  // won't fix it.
  STYTCH_ERROR: config(502),
  GCP_ERROR: config(502),
  OIDC_DISCOVERY_FAILED: config(502),
  OAUTH2_EXCHANGE_FAILED: config(502),
  // 502 — a mutating proxy dispatch may or may not have run. Never retried blindly: a resend can duplicate it.
  // Only Agent Proxy workloads receive it; no CLI outcome means "may have happened", and no CLI path raises it.
  DISPATCH_AMBIGUOUS: { status: 502, retryable: false, cliKind: null },
  // 500 — Dino itself failed.
  INTERNAL_ERROR: { status: 500, retryable: false, cliKind: 'crash' },
  SERVER_MISCONFIGURED: { status: 500, retryable: false, cliKind: 'crash' },
  // Engine / pipeline codes — never sent as an HTTP status.
  TIMEOUT: transient(null),
  NETWORK_ERROR: transient(null),
  CIRCUIT_OPEN: transient(null),
  BUDGET_EXCEEDED: config(null),
} as const satisfies Record<DinoErrorCode, ErrorContractEntry>;

/** The contract row for a code. */
export function errorContractFor(code: DinoErrorCode): ErrorContractEntry {
  return ERROR_CONTRACT[code];
}
