/**
 * @dino/core — Tenant Config Loader
 *
 * Parses a YAML tenant config file into a validated TenantConfig object.
 * Uses yaml v2 for parsing and zod v4 for schema validation.
 */

import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  checkEndpointUrl,
  isAllowedEndpointUrl,
  isBlockedIPv4,
  resolveAndValidateDNS,
  ENDPOINT_REJECT_MESSAGES,
} from './endpoint-validator';
import { safeExistsSync, safeReadFileSync } from '../utils/safe-fs';
import type { TenantConfig } from './tenant-config';

// Re-export for barrel consumers and tests
export { resolveAndValidateDNS } from './endpoint-validator';
export type { DNSValidationResult } from './endpoint-validator';

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
  expectations: z.record(z.string(), z.record(z.string(), z.string())).optional(),
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
    })
    .refine((envs) => Object.keys(envs).every((k) => /^[a-z0-9-]+$/.test(k)), {
      message:
        'Environment names must be lowercase alphanumeric with hyphens (same rules as tenant id)',
    }),
  defaultEnvironment: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9-]+$/,
      'defaultEnvironment must be lowercase alphanumeric with hyphens (same rules as tenant id)',
    ),
  auth: AuthConfigSchema.optional(),
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
    ...(config.auth ? { auth: config.auth } : {}),
    agents: config.agents,
    rbac: config.rbac,
  };
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
