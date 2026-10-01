/**
 * DIN-1492 — typed Authentication Flow outcomes. Every refusal is fail-closed and carries a stable code plus a
 * bounded NextAction from the closed union in credential-next-action.ts. A detail names steps and rules only,
 * never template contents.
 */

import { DinoError, type DinoErrorCode } from './errors';
import type { CredentialNextAction } from './credential-next-action';

export type AuthFlowOutcomeCode = Extract<DinoErrorCode, 'AUTH_FLOW_INVALID' | 'AUTH_FLOW_UNSAFE' | 'AUTH_FLOW_NOT_ADMITTED'>;

const OUTCOMES: Record<AuthFlowOutcomeCode, { message: string; nextAction: CredentialNextAction }> = {
  AUTH_FLOW_INVALID: {
    message: 'The Authentication Flow is not a valid flow definition',
    nextAction: { kind: 'provide_input', reasonCode: 'auth_flow_invalid' },
  },
  AUTH_FLOW_UNSAFE: {
    message: 'The Authentication Flow breaks a safety rule',
    nextAction: { kind: 'provide_input', reasonCode: 'auth_flow_unsafe' },
  },
  AUTH_FLOW_NOT_ADMITTED: {
    message: 'The Authentication Identity has no admitted Authentication Flow; propose one',
    nextAction: { kind: 'provide_input', reasonCode: 'auth_flow_not_admitted' },
  },
};

/** Build the typed, fail-closed error for an Authentication Flow outcome, with an optional safe detail. */
export function authFlowOutcomeError(code: AuthFlowOutcomeCode, detail?: string): DinoError {
  const o = OUTCOMES[code];
  return new DinoError({
    code,
    message: detail === undefined ? o.message : `${o.message}: ${detail}`,
    meta: { nextAction: { ...o.nextAction } },
  });
}
