/**
 * Shared pipeline utilities for CLI commands (scan, watch, etc.).
 * Extracted to prevent SonarCloud duplication between scan.ts and watch.ts.
 */

import { applyInjections, type TemplateResolver } from '@dino/auth';
import { resolveAndValidateDNS } from '@dino/core';
import { calculateNumericScore, getModuleSlugs, logger, safeEndpointUrl } from '@dino/engine';
import { CliError } from './errors';
import type {
  AccountRole,
  CondensedReport,
  PipelineExecutor,
  TokenFactory,
  TokenResolver,
  ToolName,
} from '@dino/engine';

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
  'rest-fuzzer',
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
      1,
      'Use --tools with comma-separated names from the list above.',
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
      1,
      'Check available modules with dino scan --verbose.',
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

/** #1981 — injection values are pre-resolved by the auth context; apply them verbatim (mirrors graphql-client). */
const IDENTITY_RESOLVER: TemplateResolver = { resolve: (template) => template };

/**
 * #1981 — build the outgoing headers + URL for one executor call, applying the caller's headers,
 * bearer token, and generic credential injections (header/cookie/query). Mirrors `graphql-client`'s
 * ClientOptions path: previously only `authToken` was honored (and `options.headers` was dropped
 * outright), so api_key / basic_auth / cookie-session profiles scanned unauthenticated and the run
 * completed false-CLEAN.
 */
// @internal — exported for the auth-method×protocol boundary sweep
// (tests/contract/cli/auth-application.boundary.test.ts). This is the pure request-assembly seam
// where #1981 lived (non-bearer creds dropped on the GraphQL path); testing it directly asserts the
// final outgoing HTTP without a live endpoint / DNS round-trip.
export function buildExecutorRequest(
  endpoint: string,
  options: Parameters<PipelineExecutor>[2],
): { headers: Record<string, string>; url: string } {
  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options?.headers,
    ...(options?.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
  };
  let url = endpoint;
  if (options?.injections && options.injections.length > 0) {
    const injected = applyInjections({ headers, url }, options.injections, IDENTITY_RESOLVER);
    headers = injected.headers;
    url = injected.url;
    if (injected.cookieHeader !== undefined) {
      headers.Cookie = injected.cookieHeader;
    }
  }
  if (options?.cookieHeader !== undefined && options.cookieHeader !== '') {
    headers.Cookie = options.cookieHeader;
  }
  return { headers, url };
}

/**
 * #1850 — `fetchImpl` defaults to the global `fetch` (mockable in tests); production callers that hit
 * customer-controlled targets on a POOL RUNNER pass `createPinnedFetch()` to pin the connection to the
 * validated IP (closing the DNS-rebinding TOCTOU). resolveAndValidateDNS is kept for the early CliError.
 */
export function createExecutor(
  endpoint: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): PipelineExecutor {
  return async (document, variables, options) => {
    const dnsCheck = await resolveAndValidateDNS(endpoint);
    if (!dnsCheck.allowed) {
      throw new CliError(
        `SSRF blocked: endpoint failed DNS validation (${dnsCheck.reason})`,
        1,
        'Ensure your endpoint uses a public hostname, not a private IP.',
      );
    }

    const { headers, url } = buildExecutorRequest(endpoint, options);

    const res = await fetchImpl(url, {
      // determinism:allowed
      method: 'POST',
      headers,
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

/**
 * Global health score for CLI summaries. Inverted numericScore (100 = healthy, 0 = critical).
 * Different from catalog's per-operation computeHealthScore — this covers the entire run.
 * Extracted from watch.ts (#1013) so scan.ts can reuse it.
 */
export function computeGlobalHealthScore(condensed: CondensedReport): number {
  const allFindings = condensed.envelopes.flatMap((e) => e.findings);
  const problemScore = calculateNumericScore(allFindings);
  const score = 100 - Math.min(100, problemScore);
  // Guard: if calculateNumericScore returned NaN (malformed input), default to 0
  // so healthLabel shows "Critical (0)" rather than a misleading value.
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, score);
}

/**
 * PER_OP_FINDINGS feature flag (Spec 1, task #13) — single env read for ALL
 * runPipeline construction sites (scan-pipeline, runner, watch). The engine never
 * reads env for this flag; a conformance test asserts every site calls this helper
 * so no entry point can silently stay on the legacy finding shape.
 */
export function perOpFindingsFromEnv(): boolean {
  return process.env.PER_OP_FINDINGS === 'true';
}
