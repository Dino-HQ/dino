/**
 * P1F (DIN-1353) — the closed Credential NextAction union (Machine Response contract §15).
 * Leaf module (no imports): shared by `errors.ts` serialization and `credential-outcome.ts`.
 * A NextAction grants no authority and never carries secret material — only a registered reason code.
 */

export const CREDENTIAL_NEXT_ACTION_KINDS = ['provide_input', 'retry', 'contact_support'] as const;
export type CredentialNextActionKind = (typeof CREDENTIAL_NEXT_ACTION_KINDS)[number];

/** Registered reason codes. Adding one is a contract change. */
export const CREDENTIAL_REASON_CODES = [
  'credential_reference_not_found',
  'credential_reference_revoked',
  'credential_reference_rotated',
  'credential_residency_mismatch',
  'credential_reconfigure_required',
  'credential_custody_unavailable',
  // Target Connection outcomes (DIN-1490).
  'target_connection_required',
  'target_connection_pending_authorization',
  'target_connection_suspended',
  'target_connection_revoked',
  'target_connection_retired',
  'target_connection_stale',
  'target_connection_scope_invalid',
  'target_connection_scope_unavailable',
] as const;
export type CredentialReasonCode = (typeof CREDENTIAL_REASON_CODES)[number];

export interface CredentialNextAction {
  kind: CredentialNextActionKind;
  reasonCode: CredentialReasonCode;
}

function isKind(v: string): v is CredentialNextActionKind {
  return (CREDENTIAL_NEXT_ACTION_KINDS as readonly string[]).includes(v);
}

function isReasonCode(v: string): v is CredentialReasonCode {
  return (CREDENTIAL_REASON_CODES as readonly string[]).includes(v);
}

/** Validate an untrusted value as a CredentialNextAction; anything else → undefined (fail closed). */
export function parseCredentialNextAction(value: unknown): CredentialNextAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, reasonCode } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || typeof reasonCode !== 'string') return undefined;
  if (!isKind(kind) || !isReasonCode(reasonCode)) return undefined;
  return { kind, reasonCode };
}
