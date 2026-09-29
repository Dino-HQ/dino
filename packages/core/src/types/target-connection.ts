/**
 * Target Connection (DIN-1490; CONTEXT.md "Target Connection", ADR-0022, ADR-0073, ADR-0075) — an immutable
 * version of tenant-scoped control-plane authorization between Dino and one Target: permitted schemes, ports,
 * the exact destination host and path boundary, private-address scope, the Authentication Identity context,
 * execution plane, redirect and credential-forwarding boundaries, request limits and purposes.
 *
 * Configuration is not validity: an AUTHORIZED version permits an attempt; it proves neither credential
 * capability, reachability, availability nor Target identity, and it never changes because of them. A material
 * change is a new version; its status moves only through recorded transitions.
 */

import { z } from 'zod';
import { BOOTSTRAP_IDEMPOTENCY_KEY_MAX } from './bootstrap';

/** The Surface Contract version of the `target_connection.authorize` capability. */
export const TARGET_CONNECTION_CONTRACT_VERSION = 1;

export const TARGET_CONNECTION_STATUSES = [
  'PENDING_AUTHORIZATION',
  'AUTHORIZED',
  'SUSPENDED',
  'REVOKED',
  'RETIRED',
] as const;
export type TargetConnectionStatus = (typeof TARGET_CONNECTION_STATUSES)[number];

/** The only legal status moves (layer spec §106–112). REVOKED and RETIRED are terminal. */
export const TARGET_CONNECTION_TRANSITIONS: {
  readonly [S in TargetConnectionStatus]: readonly TargetConnectionStatus[];
} = {
  PENDING_AUTHORIZATION: ['AUTHORIZED', 'RETIRED'],
  AUTHORIZED: ['SUSPENDED', 'REVOKED', 'RETIRED'],
  SUSPENDED: ['AUTHORIZED', 'REVOKED', 'RETIRED'],
  REVOKED: [],
  RETIRED: [],
};

export function canTransitionTargetConnection(
  from: TargetConnectionStatus,
  to: TargetConnectionStatus,
): boolean {
  return TARGET_CONNECTION_TRANSITIONS[from].includes(to);
}

/** Human lifecycle actions after authorization, and the status each moves the version to. */
export const TARGET_CONNECTION_LIFECYCLE_ACTIONS = {
  suspend: 'SUSPENDED',
  resume: 'AUTHORIZED',
  revoke: 'REVOKED',
  retire: 'RETIRED',
} as const satisfies Record<string, TargetConnectionStatus>;
export type TargetConnectionLifecycleAction = keyof typeof TARGET_CONNECTION_LIFECYCLE_ACTIONS;

/** Where the network operations run. A Dino Connector is not available yet (refused at proposal). */
export const TARGET_CONNECTION_EXECUTION_PLANES = [
  'dino_managed',
  'customer_runner',
  'connector',
] as const;
export type TargetConnectionExecutionPlane = (typeof TARGET_CONNECTION_EXECUTION_PLANES)[number];

/** `rfc1918` is private-address scope: reachable only through a Dino Connector, so refused until one exists. */
export const TARGET_CONNECTION_PRIVATE_SCOPES = ['none', 'rfc1918'] as const;
export type TargetConnectionPrivateScope = (typeof TARGET_CONNECTION_PRIVATE_SCOPES)[number];

export const TARGET_CONNECTION_REDIRECT_POLICIES = ['none', 'same_origin'] as const;
export type TargetConnectionRedirectPolicy = (typeof TARGET_CONNECTION_REDIRECT_POLICIES)[number];

export const TARGET_CONNECTION_PURPOSES = ['scan', 'discovery', 'verification'] as const;
export type TargetConnectionPurpose = (typeof TARGET_CONNECTION_PURPOSES)[number];

/** Platform ceilings: a Connection may only narrow them. Defaults apply when a limit is omitted. */
export const TARGET_CONNECTION_LIMIT_CEILINGS = {
  timeoutMs: 300_000,
  maxRequests: 10_000,
  maxConcurrency: 16,
  maxResponseBytes: 10_000_000,
} as const;
export type TargetConnectionRequestLimits = {
  readonly [K in keyof typeof TARGET_CONNECTION_LIMIT_CEILINGS]: number;
};

export const TARGET_CONNECTION_MAX_AUTH_PROFILES = 16;
export const TARGET_CONNECTION_MAX_FORWARDING_HOSTS = 8;
export const TARGET_CONNECTION_MAX_PORTS = 8;

const limit = (ceiling: number) => z.number().int().min(1).max(ceiling);

/** What a principal proposes. The destination host comes from the Target Definition, never the caller. */
export const TargetConnectionProposalSchema = z
  .object({
    scope: z
      .object({
        allowedSchemes: z.array(z.enum(['http', 'https'])).min(1).max(2).optional(),
        ports: z.array(z.number().int().min(1).max(65_535)).min(1).max(TARGET_CONNECTION_MAX_PORTS).optional(),
        pathPrefix: z.union([z.string().min(1).max(512), z.null()]).optional(),
      })
      .strict()
      .default({}),
    privateAddressScope: z.enum(TARGET_CONNECTION_PRIVATE_SCOPES).default('none'),
    executionPlane: z.enum(TARGET_CONNECTION_EXECUTION_PLANES),
    authentication: z
      .object({
        authProfileIds: z.array(z.string().min(1).max(128)).max(TARGET_CONNECTION_MAX_AUTH_PROFILES),
        anonymous: z.boolean(),
      })
      .strict(),
    credentialForwarding: z
      .object({
        hosts: z.array(z.string().min(1).max(253)).min(1).max(TARGET_CONNECTION_MAX_FORWARDING_HOSTS),
      })
      .strict()
      .optional(),
    redirectPolicy: z.enum(TARGET_CONNECTION_REDIRECT_POLICIES).default('none'),
    requestLimits: z
      .object({
        timeoutMs: limit(TARGET_CONNECTION_LIMIT_CEILINGS.timeoutMs).optional(),
        maxRequests: limit(TARGET_CONNECTION_LIMIT_CEILINGS.maxRequests).optional(),
        maxConcurrency: limit(TARGET_CONNECTION_LIMIT_CEILINGS.maxConcurrency).optional(),
        maxResponseBytes: limit(TARGET_CONNECTION_LIMIT_CEILINGS.maxResponseBytes).optional(),
      })
      .strict()
      .default({}),
    purposes: z.array(z.enum(TARGET_CONNECTION_PURPOSES)).min(1).max(3),
  })
  .strict();
export type TargetConnectionProposal = z.infer<typeof TargetConnectionProposalSchema>;

/** The admitted, normalized configuration of one version — exactly what is stored and compared. */
export interface TargetConnectionConfiguration {
  readonly scope: {
    readonly destinationHost: string;
    /** True when the Definition names no port: each allowed scheme's default port, paired with that scheme. */
    readonly defaultPorts: boolean;
    readonly allowedSchemes: readonly ('http' | 'https')[];
    readonly ports: readonly number[];
    readonly pathPrefix: string | null;
  };
  readonly privateAddressScope: TargetConnectionPrivateScope;
  readonly executionPlane: TargetConnectionExecutionPlane;
  readonly authentication: { readonly authProfileIds: readonly string[]; readonly anonymous: boolean };
  readonly credentialForwarding: { readonly hosts: readonly string[] };
  readonly redirectPolicy: TargetConnectionRedirectPolicy;
  readonly requestLimits: TargetConnectionRequestLimits;
  readonly purposes: readonly TargetConnectionPurpose[];
}

/** Transport-neutral projection of one version: HTTP and MCP return exactly this. */
export interface TargetConnectionVersionView {
  readonly connectionId: string;
  readonly versionId: string;
  readonly version: number;
  readonly targetId: string;
  readonly targetDefinitionVersion: number;
  readonly status: TargetConnectionStatus;
  readonly statusChangedAt: string;
  readonly configuration: TargetConnectionConfiguration;
  readonly authoredBy: string;
  readonly authoredByType: 'member' | 'service_account';
  readonly authoredAt: string;
  /** The Presentation Request that asks a human to authorize this version. */
  readonly authorizationRequestId: string;
}

const id = z.string().trim().min(1).max(128);

/** MCP `propose_target_connection`: a new Connection, or (with connectionId) its next version. */
export const TargetConnectionProposeCommandSchema = z
  .object({
    targetId: id,
    connectionId: id.optional(),
    idempotencyKey: z.string().trim().min(1).max(BOOTSTRAP_IDEMPOTENCY_KEY_MAX),
    proposal: TargetConnectionProposalSchema,
  })
  .strict();
export type TargetConnectionProposeCommand = z.infer<typeof TargetConnectionProposeCommandSchema>;

/** MCP `get_target_connection`: one version of one Connection of a Target. */
export const TargetConnectionVersionRefSchema = z
  .object({ targetId: id, connectionId: id, version: z.number().int().min(1).max(999_999_999) })
  .strict();

/** MCP `list_target_connections`: every Connection of a Target, with every version. */
export const TargetConnectionListRefSchema = z.object({ targetId: id }).strict();

/** Every Connection of a Target with every version (HTTP `GET …/connections`, MCP `list_target_connections`). */
export type TargetConnectionListView = {
  readonly connections: readonly { readonly connectionId: string; readonly versions: readonly TargetConnectionVersionView[] }[];
};

