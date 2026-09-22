/**
 * Shared pipeline utilities for CLI commands (scan, watch, etc.).
 * Extracted to prevent SonarCloud duplication between scan.ts and watch.ts.
 */

import { applyInjections, type TemplateResolver } from '@dino/auth';
import {
  ExecutorBlockedError,
  ExecutorHttpError,
  createObservedNativeFetch,
  observeTransport,
  type ObservedRequestInit,
  isTenantConfigError,
  resolveAndValidateDNS,
} from '@dino/core';
import type {
  AccountRole,
  PipelineExecutor,
  TokenFactory,
  TokenResolver,
  ToolName,
} from '@dino/engine';
import { getModuleSlugs, hasOperationsFile, logger, safeEndpointUrl } from '@dino/engine';
import { CliError } from './errors';

/** Wraps createExecutor with automatic token injection - reuses existing auth logic */
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

/** #2160: inject static auth headers on every GraphQL executor call (per-call headers win). */
export function withStaticHeaders(
  executor: PipelineExecutor,
  headers: Record<string, string>,
): PipelineExecutor {
  return async (document, variables, options) => {
    // A cell that declares itself unauthenticated gets none of them — otherwise the credential the
    // run was given is merged into the very request whose purpose is to carry none.
    if (options?.unauthenticated === true) return executor(document, variables, options);
    return executor(document, variables, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });
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

export function validateTools(tools: string[]): ToolName[] {
  const invalid = tools.filter((t) => !VALID_TOOL_NAMES.has(t));
  if (invalid.length > 0) {
    throw new CliError(
      `Invalid tool name(s): ${invalid.join(', ')}. Valid: ${[...VALID_TOOL_NAMES].join(', ')}`,
      2,
      'Use --tools with comma-separated names from the list above.',
      undefined,
      'usage',
    );
  }
  return tools as ToolName[];
}

// B42 (#608): tenantId used to be a single hardcoded tenant — SaaS landmine. Now required as parameter.
export function validateModules(modules: string[], tenantId: string): string[] {
  // Modules are defined by a tenant's operations file. An ad-hoc scan has none, and reading it
  // anyway surfaced the missing file as a crash (exit 70) — Dino blaming itself for a flag the
  // user cannot use in this mode.
  if (!hasOperationsFile(tenantId)) {
    throw new CliError(
      `--modules needs a tenant configuration, and none is available for "${tenantId}".`,
      2,
      'Run dino init to configure a tenant, or drop --modules to scan every operation.',
      undefined,
      'usage',
    );
  }
  const validSlugs = getModuleSlugs(tenantId);
  const invalid = modules.filter((m) => !validSlugs.has(m));
  if (invalid.length > 0) {
    throw new CliError(
      `Invalid module(s): ${invalid.join(', ')}. Valid: ${[...validSlugs].join(', ')}`,
      2,
      'Check available modules with dino scan --verbose.',
      undefined,
      'usage',
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
  return async (role: string, signal?: AbortSignal): Promise<string | null> => {
    if (role === 'UNAUTHENTICATED') return null;
    try {
      return await tokenFactory.getToken({ role, ...(signal ? { signal } : {}) });
    } catch (err) {
      let message = 'unknown error';
      if (err instanceof Error) message = err.message;
      else if (typeof err === 'string') message = err;
      log.warn(`[Auth] Failed to authenticate as ${role}: ${message}`);
      if (isTenantConfigError(err)) throw err;
      throw new Error(`Auth failure for role "${role}": ${message}`, {
        cause: err,
      });
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

/** #1981 - injection values are pre-resolved by the auth context; apply them verbatim (mirrors graphql-client). */
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
/** Drop every credential a header map can carry, whichever wrapper put it there. */
function withoutCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return lower !== 'authorization' && lower !== 'cookie';
    }),
  );
}

export function buildExecutorRequest(
  endpoint: string,
  options: Parameters<PipelineExecutor>[2],
): { headers: Record<string, string>; url: string } {
  // A probe that declares itself unauthenticated must reach the wire with NOTHING, from any of the
  // four sources: its own token, a header merged upstream, a resolved injection, or a cookie. The
  // REST builder already did this; here only the token was ever absent, so a wrapper that merged an
  // API-key injection or a session cookie - the pool runner's `withRunnerScanAuth` does both -
  // sent the "anonymous" RBAC cell authenticated, and it answered 200 like the authorized cell.
  if (options?.unauthenticated === true) {
    return {
      headers: { 'Content-Type': 'application/json', ...withoutCredentialHeaders(options.headers ?? {}) },
      url: endpoint,
    };
  }
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
  fetchImpl: typeof fetch = createObservedNativeFetch(),
  /** Operator opt-in for a loopback / RFC1918 target; omitted, the strict policy stands. */
  policy: { allowPrivateTarget: boolean },
): PipelineExecutor {
  return async (document, variables, options) => {
    observeTransport(options, 'not-attempted');
    const dnsCheck = await resolveAndValidateDNS(endpoint, undefined, policy);
    if (!dnsCheck.allowed) {
      throw new ExecutorBlockedError(
        `SSRF blocked: endpoint failed DNS validation (${dnsCheck.reason})`,
      );
    }

    const { headers, url } = buildExecutorRequest(endpoint, options);

    const init: ObservedRequestInit = {
      // determinism:allowed
      method: 'POST',
      headers,
      body: JSON.stringify({ query: document, variables: variables ?? null }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      onTransportState: options?.onTransportState,
      beforeTransport: options?.beforeTransport,
    };
    options?.beforeTransport?.();
    const res = await fetchImpl(url, init);

    // B47 (#612): Use forEach instead of entries() for broader compatibility
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v; // eslint-disable-line security/detect-object-injection
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const message = res.ok
        ? `API returned unexpected content-type: ${contentType} (expected application/json)`
        : `API request failed: HTTP ${res.status} ${res.statusText} from ${safeEndpointUrl(endpoint)}`;
      throw new ExecutorHttpError(message, { status: res.status, headers: responseHeaders });
    }

    let body: {
      data?: unknown;
      errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch (error_) {
      throw new ExecutorHttpError(
        `API returned invalid JSON (HTTP ${res.status}) from ${safeEndpointUrl(endpoint)}`,
        { status: res.status, headers: responseHeaders, cause: error_ },
      );
    }
    return {
      data: body.data ?? null,
      errors: body.errors ?? null,
      status: res.status,
      headers: responseHeaders,
    };
  };
}

/**
 * PER_OP_FINDINGS feature flag (Spec 1, task #13) — single env read for ALL
 * runPipeline construction sites (scan-pipeline, runner, watch). The engine never
 * reads env for this flag; a conformance test asserts every site calls this helper
 * so no entry point can silently stay on the legacy finding shape.
 */
