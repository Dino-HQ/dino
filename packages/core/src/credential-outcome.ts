/**
 * P1F (DIN-1353) — typed Credential Reference outcomes. Every credential failure is fail-closed and
 * carries a stable code plus a bounded NextAction (see credential-next-action.ts).
 */

import { DinoError, type DinoErrorCode } from './errors';
import type { CredentialNextAction } from './credential-next-action';

export type CredentialOutcomeCode = Extract<
  DinoErrorCode,
  | 'CREDENTIAL_REFERENCE_NOT_FOUND'
  | 'CREDENTIAL_REFERENCE_REVOKED'
  | 'CREDENTIAL_REFERENCE_STALE'
  | 'CREDENTIAL_RESIDENCY_MISMATCH'
  | 'CREDENTIAL_RECONFIGURE_REQUIRED'
  | 'CREDENTIAL_CUSTODY_UNAVAILABLE'
>;

const OUTCOMES: Record<
  CredentialOutcomeCode,
  { status: number; message: string; nextAction: CredentialNextAction }
> = {
  CREDENTIAL_REFERENCE_NOT_FOUND: {
    status: 404,
    message: 'Credential Reference not found',
    nextAction: { kind: 'provide_input', reasonCode: 'credential_reference_not_found' },
  },
  CREDENTIAL_REFERENCE_REVOKED: {
    status: 409,
    message: 'Credential Reference is revoked',
    nextAction: { kind: 'provide_input', reasonCode: 'credential_reference_revoked' },
  },
  CREDENTIAL_REFERENCE_STALE: {
    status: 409,
    message: 'Credential Reference was rotated after this work was admitted',
    nextAction: { kind: 'retry', reasonCode: 'credential_reference_rotated' },
  },
  CREDENTIAL_RESIDENCY_MISMATCH: {
    status: 409,
    message: 'No compliant custody path for this Credential Reference',
    nextAction: { kind: 'contact_support', reasonCode: 'credential_residency_mismatch' },
  },
  CREDENTIAL_RECONFIGURE_REQUIRED: {
    status: 409,
    message: 'This auth profile predates Credential References; recreate it for a Target to continue',
    nextAction: { kind: 'provide_input', reasonCode: 'credential_reconfigure_required' },
  },
  CREDENTIAL_CUSTODY_UNAVAILABLE: {
    status: 503,
    message: 'Secret custody is unavailable',
    nextAction: { kind: 'retry', reasonCode: 'credential_custody_unavailable' },
  },
};

export function isCredentialOutcomeCode(code: string): code is CredentialOutcomeCode {
  return Object.hasOwn(OUTCOMES, code);
}

/** Build the typed, fail-closed error for a credential outcome. */
export function credentialOutcomeError(code: CredentialOutcomeCode): DinoError {
  const o = OUTCOMES[code];
  return new DinoError({
    code,
    message: o.message,
    meta: { nextAction: { ...o.nextAction } },
  });
}
