/**
 * DIN-1566 — the agent-facing contract for configuring a Target's Authentication Identity (auth profile) over MCP.
 *
 * Secret-free by construction: the command has no credential, no free-form config JSON and no flow field, and it is
 * strict, so no field can carry credential material into MCP. A static identity (bearer, api_key, basic_auth) created
 * without a credential waits for it; a human provides the secret through a credential handoff. An identity bound to
 * an existing eligible Credential Reference needs no secret entry at all.
 *
 * OAuth2, OTP and login-flow identities are not configurable here (login flows are authored through DIN-1492).
 */

import { z } from 'zod';
import { BOOTSTRAP_IDEMPOTENCY_KEY_MAX } from './bootstrap';

const id = z.string().trim().min(1).max(128);

/** The methods an agent may configure over MCP. */
export const AUTH_PROFILE_MCP_METHODS = ['none', 'bearer', 'api_key', 'basic_auth'] as const;
export type AuthProfileMcpMethod = (typeof AUTH_PROFILE_MCP_METHODS)[number];

/** Where an API key is sent. Placement only: the key itself is never part of the configuration. */
export const AuthProfileApiKeyPlacementSchema = z
  .object({
    in: z.enum(['header', 'query']),
    name: z.string().trim().min(1).max(256),
  })
  .strict();

/** MCP `create_auth_profile`. */
export const AuthProfileCreateCommandSchema = z
  .object({
    targetId: id,
    name: z.string().trim().min(1).max(255),
    method: z.enum(AUTH_PROFILE_MCP_METHODS),
    /**
     * `login_flow`: the identity authenticates by an Authentication Flow (propose_authentication_flow); the secrets
     * that flow reads are entered by a human through the credential handoff, never sent here. Default `static`.
     */
    strategy: z.enum(['static', 'login_flow']).optional(),
    /** Required for, and only for, `api_key`. */
    apiKey: AuthProfileApiKeyPlacementSchema.optional(),
    /** An existing Credential Reference of the same Target and purpose; never a secret. Static methods only. */
    credentialReferenceId: id.optional(),
    idempotencyKey: z.string().trim().min(1).max(BOOTSTRAP_IDEMPOTENCY_KEY_MAX),
  })
  .strict()
  .superRefine((command, ctx) => {
    if (command.method === 'api_key' && command.apiKey === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: 'apiKey placement is required for api_key',
      });
    }
    if (command.method !== 'api_key' && command.apiKey !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: 'apiKey is only for the api_key method',
      });
    }
    if (command.method === 'none' && command.credentialReferenceId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentialReferenceId'],
        message: 'method none stores no credential',
      });
    }
  });
export type AuthProfileCreateCommand = z.infer<typeof AuthProfileCreateCommandSchema>;

/** MCP `get_auth_profile`. */
export const AuthProfileRefSchema = z.object({ authProfileId: id }).strict();
export type AuthProfileRef = z.infer<typeof AuthProfileRefSchema>;

/** MCP `list_auth_profiles`: every identity of the Organization, or of one Target. */
export const AuthProfileListRefSchema = z.object({ targetId: id.optional() }).strict();
export type AuthProfileListRef = z.infer<typeof AuthProfileListRefSchema>;

/**
 * The deterministic next step for an identity; `null` when nothing is required (an AUTHORIZED Target Connection binds
 * it with the credential it authorized). A hint only: it grants nothing and never claims credential or Target health.
 * `credential_required` → open a credential handoff; `credential_reconfigure_required` → a human updates the
 * identity's credential (its linked reference is unusable; no handoff for it); `auth_flow_not_admitted` → a login flow identity needs an
 * admitted Authentication Flow first; `target_connection_required` → propose a Target Connection;
 * `target_connection_pending_authorization` → a human answers its HAR;
 * `target_connection_authorization_expired` → its HAR expired unanswered: reopen its Presentation Request;
 * `target_connection_authorization_in_progress` → a response was accepted and authorization is finishing: resume
 * its Request (idempotent); `target_connection_authorization_unavailable` → its authorization Request can no longer
 * proceed: cancel it (which retires the pending version), then propose again; `target_connection_bundle_blocked` →
 * another identity bound with it is refused: fix that identity (its own nextAction) or propose without it; `target_connection_suspended` → propose it
 * again for that Connection (unchanged is allowed) and a human authorizes the new version, which replaces the suspended
 * one; `target_connection_stale` → propose a new version (the credential changed since it was authorized).
 */
/**
 * The records a step is about, so an agent acts on it without searching: the identity's Target; for a Connection step
 * the Connection version; for a pending authorization its Request, and the HAR when one is answerable now.
 */
export type AuthProfileNextActionRef = {
  readonly targetId: string;
  readonly connectionId?: string;
  readonly version?: number;
  readonly requestId?: string;
  readonly harId?: string;
  /** `target_connection_bundle_blocked`: the bound identities that are refused; each one's own nextAction says how. */
  readonly blockedBy?: readonly string[];
  /** `credential_required` for a login flow: the secret NAMES its admitted flow reads (values never leave custody). */
  readonly requiredSecrets?: readonly string[];
};

export type AuthProfileNextAction = {
  readonly kind: 'provide_input';
  readonly reasonCode:
    | 'credential_required'
    | 'credential_reconfigure_required'
    | 'auth_flow_not_admitted'
    | 'target_connection_required'
    | 'target_connection_pending_authorization'
    | 'target_connection_authorization_expired'
    | 'target_connection_authorization_in_progress'
    | 'target_connection_authorization_unavailable'
    | 'target_connection_bundle_blocked'
    | 'target_connection_suspended'
    | 'target_connection_stale';
  readonly ref?: AuthProfileNextActionRef;
};

/** An Authentication Identity as every surface reports it: non-secret configuration and a reference summary. */
export interface AuthProfileView {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly method: 'none' | 'bearer' | 'api_key' | 'basic_auth' | 'oauth2';
  readonly targetId: string | null;
  readonly credentialHint: string | null;
  readonly credentialReference: Readonly<Record<string, unknown>> | null;
  readonly configJson: string | null;
  readonly strategy: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAction: AuthProfileNextAction | null;
}

export type AuthProfileListView = {
  readonly items: readonly AuthProfileView[];
  readonly count: number;
};
