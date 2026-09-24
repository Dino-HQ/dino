/**
 * Organization-Principal identity vocabulary (ADR-0036, DIN-1352 / P1E).
 *
 * Authority attaches to the Principal and its current server-side grant — never to the client or
 * credential type (ADR-0036). `PrincipalType` says WHO holds authority; `AuthMethod` says HOW the
 * credential was presented. A service account and a human can both carry a grant, but a service
 * account never acquires human-only authority by possession of a credential.
 *
 * Surface-neutral by design: the HTTP surface builds this today and the MCP adapter (DIN-1455)
 * consumes the same shape, so a delegated agent resolves identical authorization semantics.
 */
import type { MemberRole } from './member.js';

export const PRINCIPAL_TYPES = ['human', 'service_account', 'delegated_agent'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const AUTH_METHODS = [
  'stytch_session',
  'connected_apps',
  'api_key',
  'service_token',
  'oidc_federation',
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * How the presented credential authenticated, and its lifetime. `expiresAt` is revalidated on every
 * authorization decision (ADR-0127): a token or key past expiry fails closed on the next request.
 * `subject` is the external authenticated identity (e.g. the Stytch member id) — distinct from the
 * internal Dino identity it maps to, carried as `principalId` on the resolved context.
 */
export interface AuthProvenance {
  readonly method: AuthMethod;
  readonly issuer?: string;
  readonly subject?: string;
  readonly presentedAt: Date;
  readonly expiresAt?: Date;
}

/** The current server-side authorization decision. A role is a reusable bundle of capability grants. */
export interface AccessGrant {
  readonly role: MemberRole;
}

/**
 * Provenance that an action was transmitted under an identified Organization Principal's delegated
 * authority (Delegation Context). It never transfers authorship to the client, nor grants a client
 * inherent privilege — the current grant on the acting principal still decides every action.
 */
export interface DelegationContext {
  readonly onBehalfOf: { readonly type: PrincipalType; readonly id: string };
  readonly clientId: string;
  readonly scopes: readonly string[];
}
