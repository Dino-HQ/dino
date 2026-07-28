/**
 * @dino/core — TenantConfig
 *
 * Defines the shape of a tenant configuration file.
 * Only fields with active consumers are typed here. notifications and
 * thresholds exist in YAML but are passed through as Record<string, unknown>
 * until a consumer needs typed access.
 *
 * Sonar S4782: Some optional fields use `prop?: T | undefined` for TypeScript
 * exactOptionalPropertyTypes — explicit `undefined` assignments require the union.
 */

export interface TenantConfig {
  /** Schema version for forward compatibility */
  schemaVersion: number;

  /** Unique tenant identifier (lowercase, alphanumeric + hyphens) */
  id: string;

  /** Human-readable tenant name */
  name: string;

  /** API definitions to discover and test */
  apis: ApiConfig[];

  /** Environment configurations keyed by environment name */
  environments: Record<string, EnvironmentConfig>;

  /** Default environment for agent runs */
  defaultEnvironment: string;

  /** Authentication configuration. Optional — a tenant with no auth block scans unauthenticated. */
  auth?: AuthConfig;

  /** RBAC matrix configuration */
  rbac?: RbacConfig | undefined;

  /** Which agents are enabled and their schedules */
  agents: AgentActivation[];

  /** Pass-through fields from YAML not yet typed */
  [key: string]: unknown;
}

/**
 * API configuration. Discriminated on `type`:
 * - `'graphql'` — discovery via introspection; `specPath` forbidden.
 * - `'rest'`    — discovery via OpenAPI; `specPath` required (URL or file path).
 * - `'grpc'`    — discovery via proto; `specPath` required (file path).
 *
 * `specPath` is validated as a non-empty string at config load time. Full URL
 * and file-path validation (SSRF for URLs, traversal for files) is performed
 * by the consuming discovery plugin, because the rule depends on `source`.
 */
export type ApiConfig = GraphQLApiConfig | RestApiConfig | GrpcApiConfig;

export interface GraphQLApiConfig {
  name: string;
  type: 'graphql';
  source: string;
  /** Forbidden for GraphQL. Type guarantees absence; Zod rejects if present. */
  specPath?: never;
}

export interface RestApiConfig {
  name: string;
  type: 'rest';
  source: string;
  /** OpenAPI spec URL or file path. Validated downstream (Spec 2). */
  specPath: string;
}

export interface GrpcApiConfig {
  name: string;
  type: 'grpc';
  source: string;
  /** .proto file path. Validated downstream. */
  specPath: string;
}

export interface EnvironmentConfig {
  /** Map of API name → endpoint URL */
  endpoints: Record<string, string>;

  /** Request timeout in milliseconds */
  timeout: number;

  /** Number of retries on failure */
  retries: number;
}

export interface AuthConfig {
  /** Auth adapter identifier (e.g., 'jwt', 'oauth2', 'custom-otp') */
  adapter: string;

  /** Adapter-specific configuration */
  adapterConfig: Record<string, unknown>;

  /** Role definitions for testing */
  roles: RoleConfig[];

  /** Token refresh strategy */
  tokenRefresh?: TokenRefreshConfig | undefined;
}

export interface RoleConfig {
  /** Role identifier */
  id: string;

  /** Environment variable name holding credentials */
  credentialRef: string;
}

// ── TargetAuthConfig — discriminated union (replaces loose AuthConfig) ───

/** Base fields shared by all auth configs that require roles. */
interface AuthConfigBase {
  roles: RoleConfig[];
  tokenRefresh?: TokenRefreshConfig | undefined;
}

/**
 * Discriminated union for target API auth configuration.
 *
 * Each variant carries ONLY the fields valid for that adapter type.
 * `{ adapter: 'jwt', tokenEndpoint: '...' }` is a compile error —
 * impossible states are impossible.
 *
 * Covers generic adapters only. Tenant-specific token-factory adapters have been removed
 * remain on the legacy `AuthConfig` path until migrated to a standard adapter.
 *
 * Migration: tenant configs are parsed as the loose `AuthConfig` by the
 * Zod schema, then converted to `TargetAuthConfig` via `toTargetAuthConfig()`.
 * Returns null for unrecognized adapters — caller falls back to legacy path.
 */
export type TargetAuthConfig =
  | { adapter: 'none' }
  | ({ adapter: 'jwt'; signingKey: string } & AuthConfigBase)
  | ({ adapter: 'oauth2'; tokenEndpoint: string } & AuthConfigBase)
  | ({ adapter: 'api-key' } & AuthConfigBase);

/**
 * Convert a loose AuthConfig to a typed TargetAuthConfig.
 *
 * Returns null for adapters not covered by the discriminated union
 * (e.g. tenant-specific adapters). Caller should fall back to the
 * legacy AuthConfig path for those.
 *
 * Throws on missing required fields for known adapters — a jwt config
 * without signingKey is an error, not a fallback.
 */
export function toTargetAuthConfig(auth: AuthConfig): TargetAuthConfig | null {
  switch (auth.adapter) {
    case 'none':
      return { adapter: 'none' };
    case 'jwt': {
      const signingKey = auth.adapterConfig.signingKey;
      if (typeof signingKey !== 'string' || signingKey.length === 0) {
        throw new Error('auth.adapterConfig.signingKey is required for jwt adapter');
      }
      return { adapter: 'jwt', signingKey, roles: auth.roles, tokenRefresh: auth.tokenRefresh };
    }
    case 'oauth2': {
      const tokenEndpoint = auth.adapterConfig.tokenEndpoint;
      if (typeof tokenEndpoint !== 'string' || tokenEndpoint.length === 0) {
        throw new Error('auth.adapterConfig.tokenEndpoint is required for oauth2 adapter');
      }
      return {
        adapter: 'oauth2',
        tokenEndpoint,
        roles: auth.roles,
        tokenRefresh: auth.tokenRefresh,
      };
    }
    case 'api-key':
      return { adapter: 'api-key', roles: auth.roles, tokenRefresh: auth.tokenRefresh };
    default:
      return null;
  }
}

export interface TokenRefreshConfig {
  /** How to refresh expired tokens */
  strategy: 'refresh-token' | 'reauth' | 'none';

  /** Seconds before expiry to trigger refresh */
  expiryBuffer: number;
}

export interface RbacConfig {
  /** Roles to test in RBAC matrix */
  roles: string[];
  /** Default expectations per role */
  defaults?: Record<string, string> | undefined;
  /** Per-operation × per-role expected access (validated at scan assembly). */
  expectations?: Record<string, Record<string, string>> | undefined;
}

export interface AgentActivation {
  /** Agent identifier matching agent registry */
  agentId: string;

  /** Whether this agent is enabled for this tenant */
  enabled: boolean;

  /** When this agent runs */
  schedule: AgentSchedule;
}

export interface AgentSchedule {
  /** Run on pull request events */
  onPr: boolean;

  /** Run in nightly regression suite */
  nightly: boolean;

  /** Run in weekly comprehensive suite */
  weekly: boolean;

  /** Run in monthly audit */
  monthly: boolean;
}
