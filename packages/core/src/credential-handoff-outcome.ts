/**
 * P1L (DIN-1493) — typed credential handoff outcomes. A handoff is a single-use request for one human to put
 * one Target credential into custody for one Authentication Identity. Every refusal is fail-closed and carries
 * a stable code plus a bounded NextAction; none of them grants authority or carries secret material.
 */

import { z } from 'zod';
import { DinoError, type DinoErrorCode } from './errors';
import type { CredentialNextAction } from './credential-next-action';

export type CredentialHandoffOutcomeCode = Extract<
  DinoErrorCode,
  'CREDENTIAL_HANDOFF_NOT_FOUND' | 'CREDENTIAL_HANDOFF_LINK_EXPIRED' | 'CREDENTIAL_HANDOFF_CLOSED'
>;

const OUTCOMES: Record<CredentialHandoffOutcomeCode, { message: string; nextAction: CredentialNextAction }> = {
  CREDENTIAL_HANDOFF_NOT_FOUND: {
    message: 'Credential handoff not found',
    nextAction: { kind: 'provide_input', reasonCode: 'credential_handoff_not_found' },
  },
  CREDENTIAL_HANDOFF_LINK_EXPIRED: {
    message: 'This credential handoff link expired; ask for a new link',
    nextAction: { kind: 'provide_input', reasonCode: 'credential_handoff_link_expired' },
  },
  CREDENTIAL_HANDOFF_CLOSED: {
    message: 'This credential handoff is closed; open a new one',
    nextAction: { kind: 'provide_input', reasonCode: 'credential_handoff_closed' },
  },
};

/** Build the typed, fail-closed error for a credential handoff outcome, with an optional safe detail. */
export function credentialHandoffError(code: CredentialHandoffOutcomeCode, detail?: string): DinoError {
  const o = OUTCOMES[code];
  return new DinoError({
    code,
    message: detail === undefined ? o.message : `${o.message}: ${detail}`,
    meta: { nextAction: { ...o.nextAction } },
  });
}

/** How long a handoff link stays usable. Renewable while the handoff (and its HAR, if any) remains open. */
export const CREDENTIAL_HANDOFF_LINK_TTL_SECONDS = 15 * 60;

/** How long a handoff opened without a Human Action Request stays open. One with a HAR closes with that HAR. */
export const CREDENTIAL_HANDOFF_TTL_SECONDS = 24 * 60 * 60;

/** Stated with every stored outcome: storing a credential never authorizes its use. */
export const CREDENTIAL_HANDOFF_STORED_STATEMENT =
  'Stored in custody. Using it for this Target still requires authorizing it (Human Action Request or Target Connection). This is not credential health or Target health.';

/** MCP `open_credential_handoff`: which Authentication Identity (and optional credential HAR) the handoff serves. */
export const CredentialHandoffOpenCommandSchema = z
  .object({
    authProfileId: z.string().trim().min(1).max(128),
    harId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type CredentialHandoffOpenCommand = z.infer<typeof CredentialHandoffOpenCommandSchema>;

/** A handoff as every surface reports it. Never material; `link.url` is a locator a human must still log in to use. */
export interface CredentialHandoffOpened {
  readonly handoff: {
    readonly handoffId: string;
    readonly status: 'open' | 'completed';
    readonly targetId: string;
    readonly authProfileId: string;
    readonly harId: string | null;
    readonly expiresAt: string;
    readonly linkExpiresAt: string;
    readonly result: { readonly credentialReferenceId: string; readonly version: number } | null;
  };
  readonly link: { readonly url: string; readonly expiresAt: string };
}
