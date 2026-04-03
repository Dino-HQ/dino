/**
 * @dino/core — TenantConfig
 *
 * Defines the shape of a tenant configuration file.
 * Only fields with active consumers are typed here. notifications and
 * thresholds exist in YAML but are passed through as Record<string, unknown>
 * until a consumer needs typed access.
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

  /** Authentication configuration */
  auth: AuthConfig;

  /** RBAC matrix configuration */
  rbac?: RbacConfig;

  /** Which agents are enabled and their schedules */
  agents: AgentActivation[];

  /** Pass-through fields from YAML not yet typed */
  [key: string]: unknown;
}

export interface ApiConfig {
  /** API name used as key in environment endpoints */
  name: string;

  /** API protocol type — GraphQL only for now */
  type: 'graphql';

  /** How to discover the schema (e.g., 'introspection') */
  source: string;
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
  tokenRefresh?: TokenRefreshConfig;
}

export interface RoleConfig {
  /** Role identifier */
  id: string;

  /** Environment variable name holding credentials */
  credentialRef: string;
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
  defaults?: Record<string, string>;
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
