/**
 * Project Dino — Rate Limit Validator
 *
 * Agent tool that sends burst requests to configurable operations to detect
 * and validate API rate limiting behavior. Verifies that 429 responses appear
 * at expected thresholds and that rate limit headers are present.
 *
 * Design:
 * - Sends N requests in rapid succession (configurable burst size)
 * - Detects rate limit threshold (first 429 response)
 * - Validates rate limit headers (X-RateLimit-Limit, Retry-After, etc.)
 * - Supports single operation or batch testing across modules
 * - DI pattern for testability (executor injectable)
 *
 * @example Agent usage:
 *   const result = await runRateLimitValidator({ burst: 50, dryRun: true });
 *   // result.summary.rateLimited → operations that returned 429
 *
 * @see Issue #10 — Rate limit validation
 */

import { sanitizeErrorMessage } from './_error-sanitizer';
import type { AgentClock } from './shared/agent-clock';
import { resolveClock, startTimer } from './shared/agent-clock';
import { parseRegistry } from './test-scaffolder';

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperationType = 'query' | 'mutation' | 'subscription';

export type RateLimitClass =
  | 'RATE_LIMITED'
  | 'HEADERS_ONLY'
  | 'NOT_DETECTED'
  | 'SERVER_ERROR'
  | 'AUTH_ERROR'
  | 'TIMEOUT';

/** @deprecated Use classification field instead. Kept for backward compat with existing tests. */
export type LegacyRateLimitClass = 'ALLOWED' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'AUTH_ERROR';

/**
 * Most APIs rate limit at 60+ requests/minute. Burst sizes below this floor
 * yield proportionally lower confidence in NOT_DETECTED results.
 */
export const COMMON_RATE_LIMIT_FLOOR = 60;

/**
 * Compute confidence score for a rate limit result.
 * - RATE_LIMITED / HEADERS_ONLY → always 1.0 (detection is definitive)
 * - NOT_DETECTED → burst / COMMON_RATE_LIMIT_FLOOR (capped at 1.0)
 * - SERVER_ERROR / AUTH_ERROR / TIMEOUT → 0 (cannot determine)
 */
export function computeConfidence(classification: RateLimitClass, burstSize: number): number {
  if (classification === 'RATE_LIMITED' || classification === 'HEADERS_ONLY') return 1.0;
  if (classification === 'NOT_DETECTED') return Math.min(burstSize / COMMON_RATE_LIMIT_FLOOR, 1.0);
  return 0;
}

export interface RateLimitHeader {
  name: string;
  value: string;
}

export interface BurstRequestResult {
  index: number;
  /** Per-request classification (ALLOWED at request level rolls up to HEADERS_ONLY/NOT_DETECTED at entry level). */
  classification: 'RATE_LIMITED' | 'SERVER_ERROR' | 'AUTH_ERROR' | 'ALLOWED';
  statusCode: number | null;
  durationMs: number;
  headers: RateLimitHeader[];
  errorMessage: string | null;
}

export interface RateLimitEntry {
  operation: string;
  module: string;
  type: OperationType;
  burstSize: number;
  threshold: number | null;
  /** Per-operation classification from the confidence model. */
  classification: RateLimitClass;
  /** Confidence score 0.0–1.0. Only meaningful for NOT_DETECTED results. */
  confidence: number;
  rateLimited: boolean;
  hasRateLimitHeaders: boolean;
  headerNames: string[];
  /** Actual number of requests sent (may be < burstSize if health check fails or early exit). */
  requestCount: number;
  requests: BurstRequestResult[];
  /** @deprecated Use classification + confidence instead. Kept for backward compat. */
  burstInsufficient: boolean;
}

export interface RateLimitResult {
  timestamp: string;
  environment: string;
  dryRun: boolean;
  burstSize: number;
  entries: RateLimitEntry[];
  summary: {
    totalOperations: number;
    totalRequests: number;
    rateLimited: number;
    headersOnly: number;
    notDetected: number;
    serverErrors: number;
    authErrors: number;
    averageConfidence: number;
    withHeaders: number;
    withoutHeaders: number;
    /** @deprecated Use headersOnly + notDetected instead. */
    notRateLimited: number;
    /** @deprecated Use notDetected entries with low confidence instead. */
    inconclusive: number;
  };
}

export interface RateLimitOptions {
  /** Number of requests per burst. Default: 10. */
  burst?: number;
  /** Stop burst after N consecutive 429 responses. Default: 3. Set to 0 for full burst. */
  stopAfterDetection?: number;
  /** Specific operation to test. Empty = all from registry. */
  operation?: string;
  /** Only test operations in these modules. Empty = all. */
  modules?: string[];
  /** Dry run -- don't execute, just report what would be tested. */
  dryRun?: boolean;
  /** Operation registry (required). */
  registry: Record<string, string[]>;
  /** GraphQL executor. Required when not dryRun. */
  executor?: (
    document: string,
    variables?: Record<string, unknown>,
    options?: { authToken?: string },
  ) => Promise<{
    data: unknown;
    errors: Array<{ message: string; extensions?: Record<string, unknown> }> | null;
    status: number | null;
    headers: Record<string, string>;
    extensions?: Record<string, unknown>;
  }>;
  /** Auth token for authenticated requests. */
  authToken?: string;
  envName?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error?: (msg: string) => void;
  };
  clock?: AgentClock;
}

// ---------------------------------------------------------------------------
// Rate limit header detection
// ---------------------------------------------------------------------------

const RATE_LIMIT_HEADER_NAMES = new Set([
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-policy',
]);

/**
 * Extract rate limit headers from HTTP response headers (flat map).
 * Used when executor returns top-level headers from the HTTP response.
 */
export function extractRateLimitHeaders(headers?: Record<string, string>): RateLimitHeader[] {
  if (!headers) return [];

  const result: RateLimitHeader[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (RATE_LIMIT_HEADER_NAMES.has(key.toLowerCase())) {
      result.push({ name: key.toLowerCase(), value: String(value) });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

/** Per-request classification used during burst. ALLOWED is valid at request level. */
type BurstRequestClass = 'RATE_LIMITED' | 'SERVER_ERROR' | 'AUTH_ERROR' | 'ALLOWED';

/**
 * Classify a single burst request response.
 *
 * Priority:
 * 1. RATE_LIMITED — 429 status or explicit rate limit error code
 * 2. AUTH_ERROR — 401/403
 * 3. SERVER_ERROR — 5xx
 * 4. ALLOWED — request went through
 */
export function classifyRateLimitResponse(result: {
  data: unknown;
  errors: Array<{ message: string; extensions?: Record<string, unknown> }> | null;
  status: number | null;
}): BurstRequestClass {
  // 1. Rate limited (429 or explicit code)
  if (result.status === 429) {
    return 'RATE_LIMITED';
  }

  if (result.errors) {
    for (const err of result.errors) {
      const code = err.extensions?.['code'] as string | undefined;
      if (code === 'RATE_LIMITED' || code === 'TOO_MANY_REQUESTS') {
        return 'RATE_LIMITED';
      }
    }
  }

  // 2. Auth error (null status cannot be auth error)
  if (result.status != null && (result.status === 401 || result.status === 403)) {
    return 'AUTH_ERROR';
  }

  if (result.errors) {
    for (const err of result.errors) {
      const code = err.extensions?.['code'] as string | undefined;
      if (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN') {
        return 'AUTH_ERROR';
      }
    }
  }

  // 3. Server error (null status = no HTTP response, not a server error)
  if (result.status != null && result.status >= 500) {
    return 'SERVER_ERROR';
  }

  // 4. Allowed
  return 'ALLOWED';
}

/**
 * Derive entry-level classification from burst results.
 * Rolls up per-request ALLOWED into HEADERS_ONLY or NOT_DETECTED.
 */
function deriveEntryClassification(
  rateLimited: boolean,
  hasHeaders: boolean,
  allServerError: boolean,
  allAuthError: boolean,
): RateLimitClass {
  if (rateLimited) return 'RATE_LIMITED';
  if (allAuthError) return 'AUTH_ERROR';
  if (allServerError) return 'SERVER_ERROR';
  if (hasHeaders) return 'HEADERS_ONLY';
  return 'NOT_DETECTED';
}

// ---------------------------------------------------------------------------
// Query/mutation builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal GraphQL operation string for rate limit testing.
 * We only care about the response status, not the data.
 */
export function buildRateLimitOperation(
  operationName: string,
  operationType: 'query' | 'mutation' | 'subscription',
): string {
  if (!operationName) {
    return `${operationType} { __typename }`;
  }
  const capitalName = operationName[0].toUpperCase() + operationName.slice(1);
  return `${operationType} RateLimit${capitalName} { ${operationName} }`;
}

// ---------------------------------------------------------------------------
// Per-operation burst execution (extracted for cognitive complexity)
// ---------------------------------------------------------------------------

function buildDryRunEntry(
  opName: string,
  module: string,
  opType: 'query' | 'mutation' | 'subscription',
  burstSize: number,
): RateLimitEntry {
  return {
    operation: opName,
    module,
    type: opType,
    burstSize,
    threshold: null,
    classification: 'NOT_DETECTED',
    confidence: computeConfidence('NOT_DETECTED', burstSize),
    rateLimited: false,
    hasRateLimitHeaders: false,
    headerNames: [],
    requestCount: 0,
    requests: [],
    burstInsufficient: false,
  };
}

/**
 * Build a health-check failure entry. Used when the first burst request
 * reveals the endpoint is broken (500+) or requires auth (401/403).
 */
function buildHealthFailEntry(
  opName: string,
  module: string,
  opType: 'query' | 'mutation' | 'subscription',
  burstSize: number,
  classification: 'AUTH_ERROR' | 'SERVER_ERROR' | 'TIMEOUT',
  statusCode: number,
  durationMs: number,
  response?: { errors: Array<{ message: string }> | null },
): RateLimitEntry {
  const reqClass =
    classification === 'AUTH_ERROR' ? ('AUTH_ERROR' as const) : ('SERVER_ERROR' as const);
  const errorMessage = response?.errors?.[0]?.message ?? null;
  return {
    operation: opName,
    module,
    type: opType,
    burstSize,
    threshold: null,
    classification,
    confidence: 0,
    rateLimited: false,
    hasRateLimitHeaders: false,
    headerNames: [],
    requestCount: 1,
    requests: [
      { index: 0, classification: reqClass, statusCode, durationMs, headers: [], errorMessage },
    ],
    burstInsufficient: false,
  };
}

type RateLimitExecutor = (
  document: string,
  variables?: Record<string, unknown>,
  options?: { authToken?: string },
) => Promise<{
  data: unknown;
  errors: Array<{ message: string; extensions?: Record<string, unknown> }> | null;
  status: number | null;
  headers: Record<string, string>;
  extensions?: Record<string, unknown>;
}>;

interface ExecuteBurstOptions {
  opName: string;
  module: string;
  opType: 'query' | 'mutation' | 'subscription';
  burstSize: number;
  exec: RateLimitExecutor;
  authToken: string;
  stopAfterDetection: number;
  clock: AgentClock;
}

async function executeBurst(opts: ExecuteBurstOptions): Promise<RateLimitEntry> {
  const { opName, module, opType, burstSize, exec, authToken, stopAfterDetection, clock } = opts;
  const gql = buildRateLimitOperation(opName, opType);

  const requests: BurstRequestResult[] = [];
  let threshold: number | null = null;
  const allHeaders: RateLimitHeader[] = [];
  let consecutive429 = 0;

  for (let i = 0; i < burstSize; i++) {
    const elapsed = startTimer(clock);
    try {
      const response = await exec(gql, undefined, { authToken });
      const durationMs = elapsed();

      // Health check gate on first request: if server error or auth error, bail early
      if (i === 0) {
        const status = response.status;
        if (status != null && (status === 401 || status === 403)) {
          return buildHealthFailEntry(
            opName,
            module,
            opType,
            burstSize,
            'AUTH_ERROR',
            status,
            durationMs,
            response,
          );
        }
        if (status != null && status >= 500) {
          return buildHealthFailEntry(
            opName,
            module,
            opType,
            burstSize,
            'SERVER_ERROR',
            status,
            durationMs,
            response,
          );
        }
      }

      const reqClassification = classifyRateLimitResponse(response);
      const responseHeaders = extractRateLimitHeaders(response.headers);

      if (responseHeaders.length > 0) {
        allHeaders.push(...responseHeaders);
      }

      const errors = response.errors ?? [];
      const firstError = errors[0] as
        | { message: string; extensions?: Record<string, unknown> }
        | undefined;

      requests.push({
        index: i,
        classification: reqClassification,
        statusCode: response.status,
        durationMs,
        headers: responseHeaders,
        errorMessage: firstError?.message ?? null,
      });

      if (reqClassification !== 'RATE_LIMITED') {
        consecutive429 = 0;
        continue;
      }
      threshold ??= i;
      consecutive429++;
      if (stopAfterDetection > 0 && consecutive429 >= stopAfterDetection) {
        break;
      }
    } catch (err: unknown) {
      const durationMs = elapsed();
      const message = err instanceof Error ? err.message : String(err);
      // Health check gate: if first request throws, bail as TIMEOUT
      if (i === 0) {
        return buildHealthFailEntry(opName, module, opType, burstSize, 'TIMEOUT', 0, durationMs);
      }
      consecutive429 = 0;
      requests.push({
        index: i,
        classification: 'SERVER_ERROR',
        statusCode: 0,
        durationMs,
        headers: [],
        errorMessage: sanitizeErrorMessage(message),
      });
    }
  }

  const rateLimited = threshold !== null;
  const uniqueHeaderNames = [...new Set(allHeaders.map((h) => h.name))];
  const hasHeaders = uniqueHeaderNames.length > 0;
  const allServerError =
    requests.length > 0 && requests.every((r) => r.classification === 'SERVER_ERROR');
  const allAuthError =
    requests.length > 0 && requests.every((r) => r.classification === 'AUTH_ERROR');

  const classification = deriveEntryClassification(
    rateLimited,
    hasHeaders,
    allServerError,
    allAuthError,
  );
  const confidence = computeConfidence(classification, burstSize);

  return {
    operation: opName,
    module,
    type: opType,
    burstSize,
    threshold,
    classification,
    confidence,
    rateLimited,
    hasRateLimitHeaders: hasHeaders,
    headerNames: uniqueHeaderNames,
    requestCount: requests.length,
    requests,
    burstInsufficient: !rateLimited && burstSize < 10,
  };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/** @internal Exported for invariant testing only. */
export function buildSummary(entries: RateLimitEntry[]): RateLimitResult['summary'] {
  let totalRequests = 0;
  let rateLimited = 0;
  let headersOnly = 0;
  let notDetected = 0;
  let serverErrors = 0;
  let authErrors = 0;
  let withHeaders = 0;
  let withoutHeaders = 0;
  let confidenceSum = 0;

  for (const entry of entries) {
    totalRequests += entry.requests.length;
    confidenceSum += entry.confidence;

    // New classification-based counts
    switch (entry.classification) {
      case 'RATE_LIMITED':
        break;
      case 'HEADERS_ONLY':
        headersOnly++;
        break;
      case 'NOT_DETECTED':
        notDetected++;
        break;
      case 'SERVER_ERROR':
      case 'TIMEOUT':
        serverErrors++;
        break;
      case 'AUTH_ERROR':
        authErrors++;
        break;
    }

    // Backward compat: rateLimited uses entry.rateLimited boolean
    if (entry.rateLimited) {
      rateLimited++;
    }

    if (entry.hasRateLimitHeaders) {
      withHeaders++;
    } else {
      withoutHeaders++;
    }
  }

  const averageConfidence = entries.length > 0 ? confidenceSum / entries.length : 0;

  return {
    totalOperations: entries.length,
    totalRequests,
    // Uses entry.rateLimited boolean — preserves invariant:
    // rateLimited + notRateLimited + inconclusive == totalOperations
    rateLimited,
    headersOnly,
    notDetected,
    serverErrors,
    authErrors,
    averageConfidence,
    withHeaders,
    withoutHeaders,
    notRateLimited: entries.filter((e) => !e.rateLimited && !e.burstInsufficient).length,
    inconclusive: entries.filter((e) => !e.rateLimited && e.burstInsufficient).length,
  };
}

// ---------------------------------------------------------------------------
// Summary logging
// ---------------------------------------------------------------------------

function logRateLimitSummary(
  result: RateLimitResult,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  const s = result.summary;
  log.info(
    `[RateLimitValidator] Complete: ${s.totalOperations} operations, ${s.totalRequests} requests` +
      `${result.dryRun ? ' (DRY RUN)' : ''}`,
  );

  if (s.rateLimited > 0) {
    log.info(`[RateLimitValidator] ${s.rateLimited} operation(s) rate limited`);
  }

  if (s.headersOnly > 0) {
    log.info(
      `[RateLimitValidator] ${s.headersOnly} operation(s) have rate limit headers (limit above ${result.burstSize})`,
    );
  }

  if (s.notDetected > 0 && !result.dryRun) {
    const confPct = Math.round(s.averageConfidence * 100);
    log.info(
      `[RateLimitValidator] ${s.notDetected} operation(s) not detected in ${result.burstSize} requests (${confPct}% confidence)`,
    );
  }

  if (s.authErrors > 0) {
    log.warn(
      `[RateLimitValidator] ${s.authErrors} operation(s) returned auth errors — cannot test`,
    );
  }

  if (s.serverErrors > 0) {
    log.warn(
      `[RateLimitValidator] ${s.serverErrors} operation(s) returned server errors — cannot test`,
    );
  }

  if (s.withoutHeaders > 0 && s.rateLimited > 0) {
    log.warn(`[RateLimitValidator] ${s.withoutHeaders} operation(s) missing rate limit headers`);
  }
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Run rate limit validation by sending burst requests to operations.
 *
 * This is the primary agent tool. It:
 * 1. Extracts operations from the provided registry (queries by default, or specific operation)
 * 2. For each operation: sends N requests in rapid succession
 * 3. Detects rate limit threshold (first 429)
 * 4. Checks for rate limit headers
 * 5. Returns structured report
 */
export async function runRateLimitValidator(options: RateLimitOptions): Promise<RateLimitResult> {
  const burstSize = options.burst ?? 10;
  const stopAfterDetection = options.stopAfterDetection ?? 3;
  const dryRun = options.dryRun ?? false;
  if (!dryRun && !options.executor) {
    throw new Error('executor required when not in dry-run mode');
  }
  const exec =
    options.executor ??
    (() =>
      Promise.resolve({
        data: null,
        errors: null,
        status: 0,
        headers: {},
      }));
  const authToken = options.authToken ?? '';
  const registry = options.registry;
  const envName = options.envName ?? 'unknown';
  const log = options.logger ?? NOOP_LOG;
  const clock = resolveClock(options.clock);

  log.info(`[RateLimitValidator] Starting rate limit scan on ${envName} (burst: ${burstSize})`);

  // 1. Build operation list
  const allOps = parseRegistry(registry);
  const moduleFilter =
    options.modules && options.modules.length > 0 ? new Set(options.modules) : null;

  let targetOps = allOps.filter((op) => !moduleFilter || moduleFilter.has(op.module));

  // If specific operation requested, filter to just that one
  if (options.operation) {
    targetOps = targetOps.filter((op) => op.name === options.operation);
    if (targetOps.length === 0) {
      log.warn(`[RateLimitValidator] Operation '${options.operation}' not found in registry`);
    }
  }

  log.info(`[RateLimitValidator] Testing ${targetOps.length} operations`);

  if (targetOps.length === 0) {
    const emptyResult: RateLimitResult = {
      timestamp: clock.isoNow(),
      environment: envName,
      dryRun,
      burstSize,
      entries: [],
      summary: buildSummary([]),
    };
    return emptyResult;
  }

  // 2. Execute bursts
  const entries: RateLimitEntry[] = [];

  for (const op of targetOps) {
    if (dryRun) {
      entries.push(buildDryRunEntry(op.name, op.module, op.type, burstSize));
      continue;
    }

    const entry = await executeBurst({
      opName: op.name,
      module: op.module,
      opType: op.type,
      burstSize,
      exec,
      authToken,
      stopAfterDetection,
      clock,
    });
    entries.push(entry);
  }

  // 3. Build result
  const result: RateLimitResult = {
    timestamp: clock.isoNow(),
    environment: envName,
    dryRun,
    burstSize,
    entries,
    summary: buildSummary(entries),
  };

  // 4. Log summary
  logRateLimitSummary(result, log);

  return result;
}
