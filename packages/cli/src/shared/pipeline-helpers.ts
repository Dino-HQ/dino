/**
 * Shared pipeline utilities for CLI commands (scan, watch, etc.).
 * Extracted to prevent SonarCloud duplication between scan.ts and watch.ts.
 */

import type { PipelineExecutor, TokenResolver, ToolName } from '@pipeline/runner.types';
import type { TokenFactory } from '@shared/auth/token-factory';
import type { AccountRole } from '@shared/auth/types';
import { resolveAndValidateDNS } from '@dino/core';
import { safeEndpointUrl } from '../../../../src/introspection/introspect';
import { getModuleSlugs } from '@reporters/operation-mapper';
import { logger } from '../../../../src/utils/logger';
import { CliError } from './errors';

/** Wraps createExecutor with automatic token injection — reuses existing auth logic */
export function withAuth(
  executor: PipelineExecutor,
  tokenFactory: TokenFactory,
  role: AccountRole = 'USER',
): PipelineExecutor {
  return async (document, variables, options) => {
    const token = options?.authToken ?? (await tokenFactory.getToken({ role }));
    return executor(document, variables, { ...options, authToken: token });
  };
}

/** #580: Must match ToolName (long names: rate-limit-validator, etc.) */
export const VALID_TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>([
  'input-fuzzer',
  'response-validator',
  'rbac-matrix',
  'rate-limit-validator',
  'error-code-validator',
  'deprecation-tracker',
]);

export const DEFAULT_REASONING_OPTS = {
  model: 'claude-sonnet-4-5-20250514',
  maxCostPerRunUsd: 1,
  cacheTtlMs: 3600000,
  timeoutMs: 30_000,
} as const;

export function validateTools(tools: string[]): ToolName[] {
  const invalid = tools.filter((t) => !VALID_TOOL_NAMES.has(t));
  if (invalid.length > 0) {
    throw new CliError(
      `Invalid tool name(s): ${invalid.join(', ')}. Valid: ${[...VALID_TOOL_NAMES].join(', ')}`,
    );
  }
  return tools as ToolName[];
}

// B42 (#608): tenantId used to be a single hardcoded tenant — SaaS landmine. Now required as parameter.
export function validateModules(modules: string[], tenantId: string): string[] {
  const validSlugs = getModuleSlugs(tenantId);
  const invalid = modules.filter((m) => !validSlugs.has(m));
  if (invalid.length > 0) {
    throw new CliError(
      `Invalid module(s): ${invalid.join(', ')}. Valid: ${[...validSlugs].join(', ')}`,
    );
  }
  return modules;
}

/**
 * Build a tokenResolver for the RBAC matrix from the TokenFactory.
 * Returns null for UNAUTHENTICATED (no token needed).
 * Returns token string for authenticated roles.
 * On auth failure: logs warning and throws (RBAC records as AUTH_ERROR security issue).
 */
export function buildTokenResolver(
  tokenFactory: TokenFactory,
  log: { warn: (msg: string) => void } = logger,
): TokenResolver {
  return async (role: string): Promise<string | null> => {
    if (role === 'UNAUTHENTICATED') return null;
    try {
      return await tokenFactory.getToken({ role });
    } catch (err) {
      let message = 'unknown error';
      if (err instanceof Error) message = err.message;
      else if (typeof err === 'string') message = err;
      log.warn(`[Auth] Failed to authenticate as ${role}: ${message}`);
      throw new Error(`Auth failure for role "${role}": ${message}`, { cause: err });
    }
  };
}

/**
 * Validate that every RBAC role is either UNAUTHENTICATED or defined in `auth.roles`.
 * Config-driven — not a hardcoded Circo role union.
 */
export function validateRbacRoles(rbacRoles: string[], authRoles?: Array<{ id: string }>): void {
  if (!authRoles || authRoles.length === 0) {
    const nonUnauth = rbacRoles.filter((r) => r !== 'UNAUTHENTICATED');
    if (nonUnauth.length > 0) {
      throw new CliError(
        `RBAC role(s) ${nonUnauth.join(', ')} require auth.roles to be configured in tenant config.`,
      );
    }
    return;
  }

  const configuredRoleIds = new Set(authRoles.map((r) => r.id));
  const unsupported = rbacRoles.filter((r) => r !== 'UNAUTHENTICATED' && !configuredRoleIds.has(r));
  if (unsupported.length > 0) {
    throw new CliError(
      `RBAC role(s) not found in tenant auth.roles: ${unsupported.join(', ')}. ` +
        `Configured roles: UNAUTHENTICATED, ${[...configuredRoleIds].join(', ')}. ` +
        `Add the missing role(s) to auth.roles in tenant config.`,
    );
  }
}

/**
 * Validate that every RBAC role has a matching auth role config.
 * Prevents silent skips where RBAC declares a role but auth can't resolve credentials.
 */
export function validateConfigConsistency(
  rbacRoles: string[],
  authRoles: Array<{ id: string }>,
): void {
  const authRoleIds = new Set(authRoles.map((r) => r.id));
  const missing = rbacRoles
    .filter((r) => r !== 'UNAUTHENTICATED')
    .filter((r) => !authRoleIds.has(r));
  if (missing.length > 0) {
    throw new CliError(
      `RBAC roles ${missing.join(', ')} have no auth.roles config. ` +
        `Add credential entries for these roles in tenant YAML.`,
    );
  }
}

export function createExecutor(endpoint: string): PipelineExecutor {
  return async (document, variables, options) => {
    const dnsCheck = await resolveAndValidateDNS(endpoint);
    if (!dnsCheck.allowed) {
      throw new CliError(`SSRF blocked: endpoint failed DNS validation (${dnsCheck.reason})`);
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options?.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
      },
      body: JSON.stringify({ query: document, variables: variables ?? null }),
    });

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      if (!res.ok) {
        throw new CliError(
          `API request failed: HTTP ${res.status} ${res.statusText} from ${safeEndpointUrl(endpoint)}`,
        );
      }
      throw new CliError(
        `API returned unexpected content-type: ${contentType} (expected application/json)`,
      );
    }

    let body: {
      data?: unknown;
      errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new CliError(
        `API returned invalid JSON (HTTP ${res.status}) from ${safeEndpointUrl(endpoint)}`,
      );
    }
    return {
      data: body.data ?? null,
      errors: body.errors ?? null,
      status: res.status,
      // B47 (#612): Use forEach instead of entries() for broader compatibility
      headers: (() => {
        const h: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          h[k] = v; // eslint-disable-line security/detect-object-injection
        });
        return h;
      })(),
    };
  };
}
