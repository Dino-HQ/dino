/**
 * Authentication Flow (DIN-1492) — the typed, non-secret sequence of steps the Auth Flow Runner executes to acquire
 * authentication context for one Authentication Identity of one Target. Each version is immutable; Dino admits it
 * by deterministic validation, and a Target Connection version a human authorizes binds the exact admitted version.
 *
 * Admission is not validity: an admitted flow proves neither that its credential works nor that the Target accepts
 * it. A run that acquires authentication context proves only that, for that run.
 */

import { z } from 'zod';
import { BOOTSTRAP_IDEMPOTENCY_KEY_MAX } from './bootstrap';

export const AUTHENTICATION_FLOW_STATUSES = ['ADMITTED', 'SUPERSEDED', 'RETIRED'] as const;
export type AuthenticationFlowStatus = (typeof AUTHENTICATION_FLOW_STATUSES)[number];

/** The validator rules a version passed; a change to the rules is a new ruleset. */
export const AUTHENTICATION_FLOW_ADMISSION_RULESET = 'auth-flow-admission/v1';

/** A flow may call at most this many hosts besides the Target's own destination. */
export const AUTHENTICATION_FLOW_MAX_TOKEN_HOSTS = 8;

/** A flow has at most this many steps (the long-standing login-flow bound). */
export const AUTHENTICATION_FLOW_MAX_STEPS = 50;

/** One version of an Authentication Identity's flow, as every surface returns it. */
export type AuthenticationFlowVersionView = {
  readonly versionId: string;
  readonly authProfileId: string;
  readonly targetId: string;
  readonly version: number;
  /** The admitted, non-secret flow definition: secrets appear only as `{{var}}` placeholders or a `secretRef`. */
  readonly flow: unknown;
  /** Hosts besides the Target's destination the flow may call (an identity provider, a token endpoint). */
  readonly tokenHosts: readonly string[];
  readonly flowDigest: string;
  readonly admissionRuleset: string;
  readonly status: AuthenticationFlowStatus;
  readonly statusChangedAt: string | null;
  readonly statusReason: string | null;
  readonly proposedBy: string;
  readonly proposedByType: string;
  readonly admittedAt: string;
};

const id = z.string().trim().min(1).max(128);

/** Propose a flow for an Authentication Identity (HTTP body + path, MCP `propose_authentication_flow`). */
export const AuthenticationFlowProposeCommandSchema = z
  .object({
    authProfileId: id,
    idempotencyKey: z.string().trim().min(1).max(BOOTSTRAP_IDEMPOTENCY_KEY_MAX),
    /** Validated by admission against the Auth Flow Runner's own schema and rules. */
    flow: z.unknown(),
    /** Hosts besides the Target's destination the flow may call; every other request goes to the Target. */
    tokenHosts: z.array(z.string().trim().min(1).max(253)).max(AUTHENTICATION_FLOW_MAX_TOKEN_HOSTS).optional(),
  })
  .strict();
export type AuthenticationFlowProposeCommand = z.infer<typeof AuthenticationFlowProposeCommandSchema>;

/** MCP `get_authentication_flow`: one version of one Authentication Identity's flow. */
export const AuthenticationFlowVersionRefSchema = z
  .object({ authProfileId: id, version: z.number().int().min(1).max(999_999_999) })
  .strict();

/** MCP `list_authentication_flows`: every version of one Authentication Identity's flow. */
export const AuthenticationFlowListRefSchema = z.object({ authProfileId: id }).strict();

export type AuthenticationFlowListView = { readonly versions: readonly AuthenticationFlowVersionView[] };
