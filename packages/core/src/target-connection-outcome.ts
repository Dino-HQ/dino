/**
 * DIN-1490 — typed Target Connection outcomes. Every refusal is fail-closed and carries a stable code plus a
 * bounded NextAction from the closed union in credential-next-action.ts. A NextAction grants no authority.
 */

import { DinoError, type DinoErrorCode } from './errors';
import type { CredentialNextAction, CredentialReasonCode } from './credential-next-action';

export type TargetConnectionOutcomeCode = Extract<
  DinoErrorCode,
  | 'TARGET_CONNECTION_REQUIRED'
  | 'TARGET_CONNECTION_NOT_AUTHORIZED'
  | 'TARGET_CONNECTION_STALE'
  | 'TARGET_CONNECTION_SCOPE_INVALID'
  | 'TARGET_CONNECTION_SCOPE_UNAVAILABLE'
>;

const TARGET_CONNECTION_OUTCOME_CODES: ReadonlySet<string> = new Set<TargetConnectionOutcomeCode>([
  'TARGET_CONNECTION_REQUIRED',
  'TARGET_CONNECTION_NOT_AUTHORIZED',
  'TARGET_CONNECTION_STALE',
  'TARGET_CONNECTION_SCOPE_INVALID',
  'TARGET_CONNECTION_SCOPE_UNAVAILABLE',
]);

export function isTargetConnectionOutcomeCode(code: string): code is TargetConnectionOutcomeCode {
  return TARGET_CONNECTION_OUTCOME_CODES.has(code);
}

/** Why a pinned or selected Connection version is not usable now; each is its own NextAction reason. */
export type TargetConnectionUnusableStatus = 'PENDING_AUTHORIZATION' | 'SUSPENDED' | 'REVOKED' | 'RETIRED';

const NOT_AUTHORIZED_REASON: { readonly [S in TargetConnectionUnusableStatus]: CredentialReasonCode } = {
  PENDING_AUTHORIZATION: 'target_connection_pending_authorization',
  SUSPENDED: 'target_connection_suspended',
  REVOKED: 'target_connection_revoked',
  RETIRED: 'target_connection_retired',
};

const OUTCOMES: Record<
  Exclude<TargetConnectionOutcomeCode, 'TARGET_CONNECTION_NOT_AUTHORIZED'>,
  { message: string; nextAction: CredentialNextAction }
> = {
  TARGET_CONNECTION_REQUIRED: {
    message: 'No authorized Target Connection covers this Target and auth profile',
    nextAction: { kind: 'provide_input', reasonCode: 'target_connection_required' },
  },
  TARGET_CONNECTION_STALE: {
    message: 'The Target Connection was configured against an older Target Definition; propose a new version',
    nextAction: { kind: 'provide_input', reasonCode: 'target_connection_stale' },
  },
  TARGET_CONNECTION_SCOPE_INVALID: {
    message: 'The Target Connection scope is not permitted',
    nextAction: { kind: 'provide_input', reasonCode: 'target_connection_scope_invalid' },
  },
  TARGET_CONNECTION_SCOPE_UNAVAILABLE: {
    message: 'Private-network scope and Dino Connectors are not available yet',
    nextAction: { kind: 'provide_input', reasonCode: 'target_connection_scope_unavailable' },
  },
};

/** Build the typed, fail-closed error for a Target Connection outcome, with an optional safe detail. */
export function targetConnectionOutcomeError(
  code: Exclude<TargetConnectionOutcomeCode, 'TARGET_CONNECTION_NOT_AUTHORIZED'>,
  detail?: string,
): DinoError {
  const o = OUTCOMES[code];
  return new DinoError({
    code,
    message: detail === undefined ? o.message : `${o.message}: ${detail}`,
    meta: { nextAction: { ...o.nextAction } },
  });
}

/** The Connection version exists but is not AUTHORIZED; the reason names its status. */
export function targetConnectionNotAuthorizedError(status: TargetConnectionUnusableStatus): DinoError {
  return new DinoError({
    code: 'TARGET_CONNECTION_NOT_AUTHORIZED',
    message: `The Target Connection version is ${status}`,
    meta: { nextAction: { kind: 'provide_input', reasonCode: NOT_AUTHORIZED_REASON[status] } },
  });
}

/**
 * DIN-1496 — the Authentication Flow version a Connection version authorized is no longer the admitted one (superseded,
 * retired, or never pinned). A new Connection version must bind the admitted flow and be authorized by a human.
 */
/**
 * DIN-1493 — an identity the Connection version binds now uses a different Credential Reference (a first credential,
 * or a relink) than the one the human authorized. A new version must bind it and be authorized.
 */
export function targetConnectionCredentialChangedError(detail: string): DinoError {
  return new DinoError({
    code: 'TARGET_CONNECTION_STALE',
    message: `The stored credential this Target Connection authorized has changed; propose a new version: ${detail}`,
    meta: { nextAction: { kind: 'provide_input', reasonCode: 'target_connection_credential_changed' } },
  });
}

export function targetConnectionFlowChangedError(detail: string): DinoError {
  return new DinoError({
    code: 'TARGET_CONNECTION_STALE',
    message: `The Authentication Flow this Target Connection authorized is no longer admitted; propose a new version: ${detail}`,
    meta: { nextAction: { kind: 'provide_input', reasonCode: 'target_connection_flow_changed' } },
  });
}
