/**
 * @dino/core — Tenant Config Loader
 *
 * Parses a YAML tenant config file into a validated TenantConfig object.
 * Uses yaml v2 for parsing and zod v4 for schema validation.
 */

import { promises as dns } from 'node:dns';
import { isIPv4 } from 'node:net';
import * as path from 'node:path';
import { safeExistsSync, safeReadFileSync } from '../utils/safe-fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { TenantConfig } from './tenant-config';

// --- Zod schemas ---

const AgentScheduleSchema = z.object({
  onPr: z.boolean(),
  nightly: z.boolean(),
  weekly: z.boolean(),
  monthly: z.boolean(),
});

const AgentActivationSchema = z.object({
  agentId: z.string().min(1),
  enabled: z.boolean(),
  schedule: AgentScheduleSchema,
});

const RbacConfigSchema = z.object({
  roles: z.array(z.string().min(1)).min(1, 'At least one RBAC role is required'),
  defaults: z.record(z.string(), z.string()).optional(),
});

const RoleConfigSchema = z.object({
  id: z.string().min(1),
  credentialRef: z.string().min(1),
});

const TokenRefreshSchema = z.object({
  strategy: z.enum(['refresh-token', 'reauth', 'none']),
  expiryBuffer: z.number().int().min(0),
});

const AuthConfigSchema = z
  .object({
    adapter: z.string().min(1),
    adapterConfig: z.record(z.string(), z.unknown()).default({}),
    roles: z.array(RoleConfigSchema),
    tokenRefresh: TokenRefreshSchema.optional(),
  })
  .refine((auth) => auth.adapter.toLowerCase() === 'none' || auth.roles.length >= 1, {
    message: 'auth.roles must have at least 1 role when adapter is not "none"',
    path: ['roles'],
  });

const BLOCKED_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.internal.',
  'fd00:ec2::254',
]);

function parseIPv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : Number.NaN;
  });
  if (octets.some(Number.isNaN)) return null;
  return octets;
}

/** Parse the first 16-bit group of an IPv6 address for CIDR range checks. */
function parseIPv6First16(ipv6: string): number | null {
  const first = ipv6.toLowerCase().split(':')[0];
  if (!first) return null;
  const n = Number.parseInt(first, 16);
  return Number.isNaN(n) ? null : n;
}

/** Order matches prior sequential `if` ladder (first match wins). #850, #851, #858. */
const IPV4_PRIVATE_OR_RESERVED_PREDICATES: ReadonlyArray<
  (a: number, b: number, c: number) => boolean
> = [
  (a, b) => a === 169 && b === 254,
  (a) => a === 127,
  (a) => a === 10,
  (a, b) => a === 172 && b >= 16 && b <= 31,
  (a, b) => a === 192 && b === 168,
  (a, b) => a === 100 && b >= 64 && b <= 127,
  (a, b, c) => a === 192 && b === 0 && c === 2,
  (a, b, c) => a === 198 && b === 51 && c === 100,
  (a, b, c) => a === 203 && b === 0 && c === 113,
  (a, b) => a === 198 && (b === 18 || b === 19),
];

/** Private, loopback, CGNAT, documentation, and benchmark IPv4 ranges (#850, #851, #858). */
function isIpv4PrivateOrReservedRange(a: number, b: number, c: number): boolean {
  return IPV4_PRIVATE_OR_RESERVED_PREDICATES.some((predicate) => predicate(a, b, c));
}

function isBlockedIPv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true;
  if (isIpv4PrivateOrReservedRange(a, b, c)) return true;
  if (a >= 240) return true;
  return false;
}

/** Convert IPv6 hex-pair suffix (e.g. "a9fe:a9fe") to dotted IPv4 ("169.254.169.254"). */
function hexPairsToIPv4(hex: string): string | null {
  const parts = hex.split(':');
  if (parts.length !== 2) return null;
  const hi = Number.parseInt(parts[0], 16);
  const lo = Number.parseInt(parts[1], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

/** Block IPv6 loopback, unspecified, link-local, and unique-local addresses (#575). */
function isBlockedIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  const first16 = parseIPv6First16(normalized);
  if (first16 === null) return false;
  if ((first16 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first16 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

const V4_MAPPED_RE = /^::ffff:(.+)$/i;

/** Resolve IPv4-mapped IPv6 or hex-encoded hostnames to plain IPv4. */
function resolveToIPv4(hostname: string): string | null {
  const v4Mapped = V4_MAPPED_RE.exec(hostname);
  if (v4Mapped) {
    const mapped = v4Mapped[1];
    if (isIPv4(mapped)) return mapped;
    const decoded = hexPairsToIPv4(mapped);
    if (!decoded) return null;
    return decoded;
  }
  return hostname;
}

type EndpointRejectReason =
  | 'malformed_url'
  | 'wrong_protocol'
  | 'blocked_ipv6'
  | 'metadata_host'
  | 'blocked_ipv4'
  | 'unparseable_mapped_ip';

type EndpointCheckResult = { allowed: true } | { allowed: false; reason: EndpointRejectReason };

export type DNSValidationResult =
  | { allowed: true; resolvedIP: string }
  | { allowed: false; reason: EndpointRejectReason | 'dns_resolution_failed' };

const ENDPOINT_REJECT_MESSAGES: Record<EndpointRejectReason | 'dns_resolution_failed', string> = {
  malformed_url: 'Endpoint URL is malformed',
  wrong_protocol: 'Endpoint URL must use http:// or https://',
  blocked_ipv6:
    'Endpoint URL points to a blocked IPv6 address (loopback, link-local, or unique-local)',
  metadata_host: 'Endpoint URL points to a cloud metadata service',
  blocked_ipv4: 'Endpoint URL points to a private, reserved, or loopback IPv4 address',
  unparseable_mapped_ip: 'Endpoint URL contains an unparseable IPv4-mapped IPv6 address',
  dns_resolution_failed: 'Endpoint hostname could not be resolved via DNS',
};

function checkEndpointUrl(url: string): EndpointCheckResult {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { allowed: false, reason: 'wrong_protocol' };
    }

    let hostname = parsed.hostname;
    while (hostname.endsWith('.')) hostname = hostname.slice(0, -1);

    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }

    if (isBlockedIPv6(hostname)) return { allowed: false, reason: 'blocked_ipv6' };

    if (BLOCKED_METADATA_HOSTS.has(hostname) || BLOCKED_METADATA_HOSTS.has(`${hostname}.`)) {
      return { allowed: false, reason: 'metadata_host' };
    }

    const resolved = resolveToIPv4(hostname);
    if (resolved === null) return { allowed: false, reason: 'unparseable_mapped_ip' };

    if (isIPv4(resolved)) {
      const octets = parseIPv4Octets(resolved);
      if (octets && isBlockedIPv4(octets)) return { allowed: false, reason: 'blocked_ipv4' };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'malformed_url' };
  }
}

/** Validate endpoint URL is http(s) and not a cloud metadata or private-range endpoint. */
function isAllowedEndpointUrl(url: string): boolean {
  return checkEndpointUrl(url).allowed;
}

type DNSResolver = {
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6?: (hostname: string) => Promise<string[]>;
};

async function withDnsTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS resolution timeout')), timeoutMs); // determinism:seam
  });
  try {
    return await Promise.race([promise, timeoutError]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHostnameForDnsLookup(parsed: URL): string {
  let hostname = parsed.hostname;
  while (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  return hostname;
}

async function resolveHostnameViaDns(hostname: string, resolve: DNSResolver): Promise<string[]> {
  const DNS_TIMEOUT_MS = 5_000;
  let ips: string[] = [];
  try {
    ips = await withDnsTimeout(resolve.resolve4(hostname), DNS_TIMEOUT_MS);
  } catch (_ipv4Err) {
    // IPv4 failed — try IPv6 below when available.
    void _ipv4Err;
  }
  if (ips.length === 0 && resolve.resolve6) {
    try {
      ips = await withDnsTimeout(resolve.resolve6(hostname), DNS_TIMEOUT_MS);
    } catch (_ipv6Err) {
      // IPv6 resolution failed after IPv4 failure or empty IPv4 result.
      void _ipv6Err;
    }
  }
  return ips;
}

function validateDnsResolvedIpList(ips: string[]): DNSValidationResult {
  for (const ip of ips) {
    if (isBlockedIPv6(ip)) return { allowed: false, reason: 'blocked_ipv6' };
    const resolved = resolveToIPv4(ip);
    if (resolved === null) return { allowed: false, reason: 'unparseable_mapped_ip' };
    if (isIPv4(resolved)) {
      const octets = parseIPv4Octets(resolved);
      if (octets && isBlockedIPv4(octets)) {
        return { allowed: false, reason: 'blocked_ipv4' };
      }
    }
  }
  return { allowed: true, resolvedIP: ips[0] };
}

/**
 * Runtime DNS validation to prevent DNS rebinding SSRF bypasses (#870).
 * Should be called immediately before making outbound HTTP requests.
 */
export async function resolveAndValidateDNS(
  url: string,
  resolver?: DNSResolver,
): Promise<DNSValidationResult> {
  const staticCheck = checkEndpointUrl(url);
  if (!staticCheck.allowed) return staticCheck;

  const parsed = new URL(url);
  const hostname = normalizeHostnameForDnsLookup(parsed);

  if (hostname.includes(':')) {
    return { allowed: true, resolvedIP: hostname };
  }
  if (isIPv4(hostname)) {
    return { allowed: true, resolvedIP: hostname };
  }

  const resolve = resolver ?? dns;
  const ips = await resolveHostnameViaDns(hostname, resolve);

  if (ips.length === 0) {
    return { allowed: false, reason: 'dns_resolution_failed' };
  }

  return validateDnsResolvedIpList(ips);
}

const EndpointUrlSchema = z.string().superRefine((url, ctx) => {
  const result = checkEndpointUrl(url);
  if (result.allowed) return;
  ctx.addIssue(ENDPOINT_REJECT_MESSAGES[result.reason]);
});

const EnvironmentConfigSchema = z.object({
  endpoints: z.record(z.string(), EndpointUrlSchema),
  timeout: z.number().int().positive(),
  retries: z.number().int().min(0),
});

// Zod schemas for each variant of ApiConfig. Discriminated on `type` so that
// invalid shapes (e.g. rest without specPath, graphql with specPath) fail at
// load time with a precise path, not at runtime inside a discovery plugin.
//
// specPath rejects whitespace-only and null-byte-containing strings so that a
// semantically-empty path never reaches the discovery plugin (Spec 2+).
// Full URL / filesystem validation (SSRF for URLs, traversal for files) is
// still the discovery plugin's job — this schema only rejects unambiguously
// broken content.
const SpecPathSchema = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0 && !s.includes('\0'), {
    message: 'specPath must be non-whitespace and must not contain null bytes',
  });

const GraphQLApiConfigSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal('graphql'),
    source: z.string().min(1),
  })
  .strict();

const RestApiConfigSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal('rest'),
    source: z.string().min(1),
    specPath: SpecPathSchema,
  })
  .strict();

const GrpcApiConfigSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal('grpc'),
    source: z.string().min(1),
    specPath: SpecPathSchema,
  })
  .strict();

const ApiConfigSchema = z.discriminatedUnion('type', [
  GraphQLApiConfigSchema,
  RestApiConfigSchema,
  GrpcApiConfigSchema,
]);

const TenantConfigSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1),
  apis: z
    .array(ApiConfigSchema)
    .min(1)
    .refine((apis) => new Set(apis.map((a) => a.name)).size === apis.length, {
      message: 'apis[].name must be unique within a tenant config',
    }),
  environments: z
    .record(z.string(), EnvironmentConfigSchema)
    .refine((envs) => Object.keys(envs).length > 0, {
      message: 'At least one environment is required',
    }),
  defaultEnvironment: z.string().min(1),
  auth: AuthConfigSchema,
  agents: z.array(AgentActivationSchema),
  rbac: RbacConfigSchema.optional(),
});

/** YAML keys allowed through without Zod field definitions (#857). */
const KNOWN_PASSTHROUGH_KEYS = new Set(['notifications', 'thresholds'] as const);

// --- Public API ---

/**
 * Load and validate a tenant config from a YAML file.
 *
 * @param filePath - Absolute or relative path to the tenant YAML file
 * @returns Validated TenantConfig
 * @throws Error if file not found, YAML is malformed, or validation fails
 */
export function loadTenantConfig(filePath: string): TenantConfig {
  const resolvedPath = path.resolve(filePath);

  const resolvedDir = path.dirname(resolvedPath);
  const resolvedBase = path.basename(resolvedPath);

  if (!safeExistsSync(resolvedBase, resolvedDir)) {
    throw new Error(`Tenant config file not found: ${resolvedPath}`);
  }

  const raw = safeReadFileSync(resolvedBase, resolvedDir);
  const parsed = parseYaml(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Tenant config file is empty or not a valid YAML object: ${resolvedPath}`);
  }

  return validateTenantConfig(parsed);
}

/**
 * Validate a raw parsed object against the TenantConfig schema.
 *
 * @param raw - Parsed YAML object
 * @returns Validated TenantConfig
 * @throws Error with details if validation fails
 */
export function validateTenantConfig(raw: unknown): TenantConfig {
  const result = TenantConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Tenant config validation failed:\n${issues}`);
  }

  // Validate defaultEnvironment exists in environments
  const config = result.data;
  if (!(config.defaultEnvironment in config.environments)) {
    throw new Error(
      `defaultEnvironment "${config.defaultEnvironment}" not found in environments. ` +
        `Available: ${Object.keys(config.environments).join(', ')}`,
    );
  }

  // B96 (#665): Warn on unsupported schemaVersion — currently only version 1 is supported
  const SUPPORTED_SCHEMA_VERSION = 1;
  if (config.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    console.warn(
      `[tenant] Config "${config.id}" uses schemaVersion ${config.schemaVersion} ` +
        `but this version of Dino only supports version ${SUPPORTED_SCHEMA_VERSION}. ` +
        `Some fields may not be parsed correctly. Update Dino to the latest version.`,
    );
  }

  const rawObj = raw as Record<string, unknown>;
  const passthrough: Record<string, unknown> = {};
  for (const key of KNOWN_PASSTHROUGH_KEYS) {
    if (!Object.hasOwn(rawObj, key)) continue;
    switch (key) {
      case 'notifications':
        passthrough.notifications = rawObj.notifications;
        break;
      case 'thresholds':
        passthrough.thresholds = rawObj.thresholds;
        break;
      default: {
        const _exhaustive: never = key;
        throw new Error(`Unhandled passthrough key: ${_exhaustive}`);
      }
    }
  }

  return {
    ...passthrough,
    schemaVersion: config.schemaVersion,
    id: config.id,
    name: config.name,
    apis: config.apis,
    environments: config.environments,
    defaultEnvironment: config.defaultEnvironment,
    auth: config.auth,
    agents: config.agents,
    rbac: config.rbac,
  } as TenantConfig;
}

/**
 * Find the project root by walking up from a starting directory until
 * we find a directory containing turbo.json (monorepo root marker).
 */
function findProjectRoot(startDir: string): string {
  let current = startDir;
  const root = path.parse(current).root;

  while (current !== root) {
    if (safeExistsSync('turbo.json', current)) {
      return current;
    }
    current = path.dirname(current);
  }

  // Fallback: no turbo.json found (global install or standalone CLI)
  // No console.debug — tenant-loader has no logger import and project rules forbid console in production
  return startDir;
}

/**
 * Load a tenant config by tenant ID from the tenant config directory.
 *
 * @param tenantId - Tenant identifier (e.g., 'acme')
 * @param tenantsDir - Path to the tenant config directory
 * @returns Validated TenantConfig
 */
export function loadTenantById(tenantId: string, tenantsDir?: string): TenantConfig {
  if (!/^[a-z0-9-]+$/.test(tenantId)) {
    throw new Error(
      `Invalid tenant ID "${tenantId}". Must be lowercase alphanumeric with hyphens only.`,
    );
  }

  const dir = tenantsDir ?? path.join(findProjectRoot(process.cwd()), 'tenants');
  const filePath = path.join(dir, `${tenantId}.yml`);
  return loadTenantConfig(filePath);
}

/** Test-only access to SSRF helpers (not part of the public package API). */
export const _testing = {
  checkEndpointUrl,
  isAllowedEndpointUrl,
  isBlockedIPv4,
  resolveAndValidateDNS,
} as const;
