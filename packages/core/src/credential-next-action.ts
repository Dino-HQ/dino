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
  // Credential handoff outcomes (DIN-1493).
  'credential_required',
  'credential_handoff_not_found',
  'credential_handoff_link_expired',
  'credential_handoff_closed',
  // Target Connection outcomes (DIN-1490).
  'target_connection_required',
  'target_connection_pending_authorization',
  'target_connection_suspended',
  'target_connection_revoked',
  'target_connection_retired',
  'target_connection_stale',
  'target_connection_scope_invalid',
  'target_connection_scope_unavailable',
  // The Connection's pinned Authentication Flow version is no longer admitted (DIN-1496).
  'target_connection_flow_changed',
  // The Credential Reference an identity uses is not the one its Connection authorized (DIN-1493).
  'target_connection_credential_changed',
  // Authentication Flow outcomes (DIN-1492).
  'auth_flow_invalid',
  'auth_flow_unsafe',
  'auth_flow_not_admitted',
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
