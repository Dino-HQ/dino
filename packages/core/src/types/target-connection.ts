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
        /**
         * DIN-1496: per bound `login_flow` auth profile, the admitted Authentication Flow version to authorize.
         * Each must be that profile's admitted version; omitted, Dino binds the admitted version of each.
         */
        flowVersions: z.record(z.string().min(1).max(128), z.number().int().min(1)).optional(),
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

/** One pinned Authentication Flow version: its id, number and content digest (a different digest is a different flow). */
export interface TargetConnectionFlowPin {
  readonly versionId: string;
  readonly version: number;
  readonly flowDigest: string;
}

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
  readonly authentication: {
    readonly authProfileIds: readonly string[];
    readonly anonymous: boolean;
    /** DIN-1496: the exact admitted Authentication Flow version each bound `login_flow` profile authorizes. */
    readonly flowVersions: Readonly<Record<string, TargetConnectionFlowPin>>;
    /**
     * DIN-1493: the Credential Reference each bound profile held when this version was proposed (null: none). Using
     * a different reference — a first credential, or a relink — needs a new version authorized by a human; rotating
     * versions of the same reference is the Credential Reference lifecycle and stays within this authorization.
     */
    readonly credentialReferences: Readonly<Record<string, string | null>>;
  };
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
  /** This version as a proposal: passed back unchanged, it proposes the same configuration (same digest). */
  readonly proposal: TargetConnectionProposal;
  readonly authoredBy: string;
  readonly authoredByType: 'member' | 'service_account';
  readonly authoredAt: string;
  /** The Presentation Request that asks a human to authorize this version. */
  readonly authorizationRequestId: string;
  /** This version's configuration digest: a human's authorization names it, binding the approval to this scope (DIN-1498). */
  readonly configurationDigest: string;
}

const SCHEME_DEFAULT_PORT: Readonly<Record<string, number>> = { http: 80, https: 443 };

/** Ports admission derived (every allowed scheme's default), not ports a proposal narrowed explicitly. */
function isDerivedDefaultPorts(scope: TargetConnectionConfiguration['scope']): boolean {
  if (!scope.defaultPorts) return false;
  const derived = [...new Set(scope.allowedSchemes.map((s) => SCHEME_DEFAULT_PORT[s]))].sort((a, b) => (a ?? 0) - (b ?? 0));
  return derived.length === scope.ports.length && derived.every((port, i) => port === scope.ports[i]);
}

/**
 * The proposal that admits exactly this configuration again. The admitted configuration also carries what admission
 * derives — the destination host, whether ports are the Definition's defaults, the credential pins, and forwarding of an
 * anonymous Connection — which a caller never proposes; this drops them, so a read-back re-proposes unchanged.
 */
export function proposalOf(configuration: TargetConnectionConfiguration): TargetConnectionProposal {
  const { scope, authentication } = configuration;
  const flowVersions = Object.fromEntries(
    Object.entries(authentication.flowVersions).map(([profileId, pin]) => [profileId, pin.version]),
  );
  return {
    scope: {
      allowedSchemes: [...scope.allowedSchemes],
      ...(isDerivedDefaultPorts(scope) ? {} : { ports: [...scope.ports] }),
      pathPrefix: scope.pathPrefix,
    },
    privateAddressScope: configuration.privateAddressScope,
    executionPlane: configuration.executionPlane,
    authentication: {
      authProfileIds: [...authentication.authProfileIds],
      anonymous: authentication.anonymous,
      ...(Object.keys(flowVersions).length === 0 ? {} : { flowVersions }),
    },
    ...(authentication.anonymous ? {} : { credentialForwarding: { hosts: [...configuration.credentialForwarding.hosts] } }),
    redirectPolicy: configuration.redirectPolicy,
    requestLimits: { ...configuration.requestLimits },
    purposes: [...configuration.purposes],
  };
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

