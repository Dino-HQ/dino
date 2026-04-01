/**
 * Project Dino — RBAC Matrix Runner
 *
 * Agent tool that systematically tests every mutation against every auth state
 * to verify permission boundaries. Auth bypass is the #1 security risk for
 * a platform handling real money.
 *
 * Design:
 * - Constructs schema-valid GraphQL mutations (testing auth gates, not business logic)
 * - Classifies responses: AUTH_ERROR, PERMISSION_ERROR, BUSINESS_ERROR,
 *   SCHEMA_VALIDATION_ERROR, SUCCESS
 * - Compares against expectations map (rbac-expectations.ts)
 * - Flags security issues: operations that don't enforce auth when they should
 * - Tracks which middleware layer intercepted each request
 *
 * @example Agent usage:
 *   const result = await runRbacMatrix({ modules: ['payment'] });
 *   // result.summary.securityIssues → operations with auth enforcement gaps
 */

import { recordGet, recordSet } from '@dino/core';
import { sanitizeErrorMessage } from './_error-sanitizer';
import {
  type AuthState,
  type ExpectedAccess,
  type ExpectationsMap,
  type DefaultExpectationsMap,
  getExpectation,
} from './rbac-expectations';
import { parseRegistry } from './test-scaffolder';
import { buildSmartMutation, guessOperationArgs, type TypeMaps } from './query-builder';
import type { AgentClock } from './shared/agent-clock';
import { resolveClock, startTimer } from './shared/agent-clock';

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} };

/** Local type for introspection data (host provides via options). */
export interface IntrospectionOperation {
  name: string;
  type?: string;
  args: Array<{ name: string; type: string; isRequired: boolean }>;
  returnType?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResponseClass =
  | 'AUTH_ERROR'
  | 'PERMISSION_ERROR'
  | 'BUSINESS_ERROR'
  | 'SCHEMA_VALIDATION_ERROR'
  | 'VARIABLE_COERCION_ERROR'
  | 'TIMEOUT_ERROR'
  | 'SUCCESS'
  | 'UNKNOWN_ERROR';

/** Where in the middleware chain the request was intercepted. */
export type InterceptionLayer =
  | 'graphql_validation'
  | 'variable_coercion'
  | 'auth_middleware'
  | 'resolver'
  | 'dry_run'
  | 'unknown';

export interface RbacMatrixEntry {
  operation: string;
  module: string;
  authState: AuthState;
  expected: ExpectedAccess;
  actual: ResponseClass;
  interceptedBy: InterceptionLayer;
  pass: boolean;
  /** True when request was blocked before reaching auth — result is not conclusive. */
  inconclusive: boolean;
  errorMessage: string | null;
  durationMs: number;
  /** True when mutation/query args were inferred (no introspection or op missing from index). */
  argsGuessed?: boolean;
}

export interface SecurityIssue {
  operation: string;
  module: string;
  authState: AuthState;
  expected: ExpectedAccess;
  actual: ResponseClass;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  description: string;
}

export interface RbacMatrixResult {
  timestamp: string;
  environment: string;
  dryRun: boolean;
  entries: RbacMatrixEntry[];
  securityIssues: SecurityIssue[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    inconclusive: number;
    skipped: number;
    schemaValidationCount: number;
    variableCoercionCount: number;
    timeoutCount: number;
    byAuthState: Record<string, { total: number; passed: number; failed: number }>;
    securityIssueCount: number;
    /** Count of matrix entries where args were guessed, not taken from introspection. */
    argsGuessedCount: number;
  };
}

export interface RbacMatrixOptions {
  /** Operation registry (required). */
  registry: Record<string, string[]>;
  /** Only test operations in these modules. Empty = all. */
  modules?: string[];
  /** Roles (auth states) to test. Default: UNAUTHENTICATED, USER, CREATOR, ADMIN. */
  roles?: string[];
  /** Known expectations map. Caller provides from tenant. */
  expectations?: ExpectationsMap;
  /** Default expectation per role for unspecified operations. Caller provides from tenant. */
  defaultExpectations?: DefaultExpectationsMap;
  /** Dry run — don't execute, just report what would be tested. */
  dryRun?: boolean;
  /** Safe mode — use minimal stub values and send X-Dino-Test header. Default: true. */
  safeMode?: boolean;
  /** Token resolver — returns auth token for a given state. */
  tokenResolver?: (authState: string) => Promise<string | null>;
  /** GraphQL executor. Required when not dryRun. */
  executor?: (
    document: string,
    variables?: Record<string, unknown>,
    options?: { authToken?: string; headers?: Record<string, string> },
  ) => Promise<{ data: unknown; errors: Array<GraphQLError> | null; status: number | null }>;
  /** Operation types to test. Default: ['mutation'] for backward compat. */
  operationTypes?: Array<'mutation' | 'query'>;
  /** Introspection data for arg resolution. Falls back to guessed args when absent. */
  introspectionData?: IntrospectionOperation[];
  /** Type maps for recursive stub generation (input object fields + enum values). */
  typeMaps?: TypeMaps;
  envName?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error?: (msg: string) => void;
  };
  clock?: AgentClock;
}

// ---------------------------------------------------------------------------
// Operation extraction
// ---------------------------------------------------------------------------

export interface OperationInfo {
  name: string;
  module: string;
  type: 'mutation' | 'query';
}

/**
 * Extract operations from the registry for RBAC testing.
 * By default tests mutations only (backward compatible).
 * Pass operationTypes to also include queries.
 */
export function extractOperations(
  registry: Record<string, string[]>,
  modules?: string[],
  operationTypes: Array<'mutation' | 'query'> = ['mutation'],
): OperationInfo[] {
  const moduleFilter = modules && modules.length > 0 ? new Set(modules) : null;
  const typeFilter = new Set(operationTypes);
  return parseRegistry(registry)
    .filter((op) => typeFilter.has(op.type as 'mutation' | 'query'))
    .filter((op) => !moduleFilter || moduleFilter.has(op.module))
    .map((op) => ({ name: op.name, module: op.module, type: op.type as 'mutation' | 'query' }));
}

/**
 * Extract all mutations from the operation registry.
 * Backward-compat alias for extractOperations(registry, modules, ['mutation']).
 */
export function extractMutations(
  registry: Record<string, string[]>,
  modules?: string[],
): OperationInfo[] {
  return extractOperations(registry, modules, ['mutation']);
}

// ---------------------------------------------------------------------------
// Minimal mutation construction
// ---------------------------------------------------------------------------

/**
 * Build a minimal GraphQL mutation string (legacy, kept for backwards compat).
 * Superseded by buildSmartMutation() from query-builder.ts which adds
 * variable declarations and selection sets to pass schema validation.
 */
export function buildMinimalMutation(operationName: string): string {
  if (!operationName) {
    return 'mutation { __typename }';
  }
  const capitalName = operationName[0].toUpperCase() + operationName.slice(1);
  return `mutation ${capitalName} { ${operationName} }`;
}

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

/** Patterns indicating an authentication failure (no valid token). */
const AUTH_ERROR_PATTERNS = [
  'unauthenticated',
  'unauthorized',
  'not authenticated',
  'invalid token',
  'token expired',
  'jwt expired',
  'jwt malformed',
  'no auth',
  'authentication required',
  'access denied',
  'must be logged in',
  'no access token',
  'access token',
  'token not found',
  'missing token',
];

/** Patterns indicating a permission/role failure (valid token, wrong role). */
const PERMISSION_ERROR_PATTERNS = [
  'forbidden',
  'permission denied',
  'insufficient permissions',
  'not authorized',
  'role required',
  'admin only',
  'creator only',
  'does not have permission',
  'not allowed',
];

/** Schema validation patterns — checked BEFORE business error patterns.
 * Match GraphQL engine errors that occur before auth middleware.
 * Multi-word phrases avoid false-matching business messages. */
const SCHEMA_VALIDATION_PATTERNS = [
  'variable "$',
  'unknown argument',
  'cannot query field',
  'expected type',
  'syntax error',
  'unknown type',
  'fragment cannot be spread',
];

/** Patterns indicating a business logic error (auth passed, resolver rejected). */
const BUSINESS_ERROR_PATTERNS = [
  'validation',
  'invalid',
  'not found',
  'required',
  'cannot',
  'already exists',
];

/** GraphQL error shape with optional extensions (Apollo, Yoga, etc.) */
export interface GraphQLError {
  message: string;
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

/** Check if a message matches any pattern in the list. */
function matchesAny(message: string, patterns: string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern));
}

/** Map a GraphQL extension code to a ResponseClass, or null if unrecognized. */
const EXTENSION_CODE_MAP: Record<string, ResponseClass> = {
  GRAPHQL_VALIDATION_FAILED: 'SCHEMA_VALIDATION_ERROR',
  BAD_USER_INPUT: 'VARIABLE_COERCION_ERROR',
  UNAUTHENTICATED: 'AUTH_ERROR',
  FORBIDDEN: 'PERMISSION_ERROR',
};

/** Priority for extension codes when multiple errors have different codes. */
const EXTENSION_PRIORITY: Record<string, number> = {
  UNAUTHENTICATED: 1,
  FORBIDDEN: 2,
  GRAPHQL_VALIDATION_FAILED: 3,
  BAD_USER_INPUT: 4,
};

/**
 * Classify a GraphQL response into an auth-relevant category.
 *
 * Priority order:
 * 1. Scan ALL errors for extension codes (most precise); best priority wins.
 * 2. Fall back to string matching on combined messages from all errors.
 * 3. Schema validation patterns are checked before business error patterns.
 */
export function classifyResponse(result: {
  data: unknown;
  errors: Array<GraphQLError> | null;
}): ResponseClass {
  if (!result.errors || result.errors.length === 0) {
    return 'SUCCESS';
  }

  // Phase 1: Check ALL errors for extension codes (most precise).
  let bestCode: string | null = null;
  let bestPriority = Infinity;
  for (const error of result.errors) {
    const extensionCode = error.extensions?.code?.toUpperCase();
    if (extensionCode && extensionCode in EXTENSION_CODE_MAP) {
      const priority = recordGet(EXTENSION_PRIORITY, extensionCode) ?? 99;
      if (priority < bestPriority) {
        bestCode = extensionCode;
        bestPriority = priority;
      }
    }
  }
  if (bestCode) {
    return recordGet(EXTENSION_CODE_MAP, bestCode) ?? 'UNKNOWN_ERROR';
  }

  // Phase 2: Fall back to string matching across ALL error messages.
  const allMessages = result.errors.map((e) => e.message.toLowerCase());
  const combined = allMessages.join(' ');

  if (matchesAny(combined, ['aborted', 'timed out', 'timeout'])) return 'TIMEOUT_ERROR';
  if (matchesAny(combined, SCHEMA_VALIDATION_PATTERNS)) return 'SCHEMA_VALIDATION_ERROR';
  if (matchesAny(combined, AUTH_ERROR_PATTERNS)) return 'AUTH_ERROR';
  if (matchesAny(combined, PERMISSION_ERROR_PATTERNS)) return 'PERMISSION_ERROR';
  if (matchesAny(combined, BUSINESS_ERROR_PATTERNS)) return 'BUSINESS_ERROR';

  return 'UNKNOWN_ERROR';
}

/**
 * Determine which middleware layer intercepted the request.
 */
export function determineInterceptionLayer(responseClass: ResponseClass): InterceptionLayer {
  switch (responseClass) {
    case 'SCHEMA_VALIDATION_ERROR':
      return 'graphql_validation';
    case 'VARIABLE_COERCION_ERROR':
      return 'variable_coercion';
    case 'AUTH_ERROR':
    case 'PERMISSION_ERROR':
      return 'auth_middleware';
    case 'BUSINESS_ERROR':
    case 'SUCCESS':
      return 'resolver';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Pass/fail evaluation
// ---------------------------------------------------------------------------

/**
 * Determine if an actual response matches the expected access.
 *
 * SCHEMA_VALIDATION_ERROR, VARIABLE_COERCION_ERROR, and TIMEOUT_ERROR are
 * treated as inconclusive for DENY — the request was blocked before auth.
 * They pass (no false alarm) but are not counted as confirmed auth enforcement.
 */
export function evaluateResult(expected: ExpectedAccess, actual: ResponseClass): boolean {
  if (expected === 'UNKNOWN') {
    return true; // No expectation → always passes
  }
  if (expected === 'DENY') {
    return (
      actual === 'AUTH_ERROR' ||
      actual === 'PERMISSION_ERROR' ||
      actual === 'SCHEMA_VALIDATION_ERROR' ||
      actual === 'VARIABLE_COERCION_ERROR' ||
      actual === 'TIMEOUT_ERROR'
    );
  }
  // expected === 'ALLOW'
  return actual === 'SUCCESS' || actual === 'BUSINESS_ERROR';
}

/**
 * Detect security issues: cases where auth should be enforced but isn't.
 *
 * Pre-auth rejections (schema validation, variable coercion, timeouts) are
 * NOT security issues — the request never reached auth. These are inconclusive.
 * UNAUTHENTICATED + BUSINESS_ERROR is always a CRITICAL issue (auth bypass).
 */
export function detectSecurityIssue(entry: RbacMatrixEntry): SecurityIssue | null {
  // Case 2 first (specific): UNAUTHENTICATED + DENY + BUSINESS_ERROR = auth middleware bypassed
  if (
    entry.authState === 'UNAUTHENTICATED' &&
    entry.expected === 'DENY' &&
    entry.actual === 'BUSINESS_ERROR'
  ) {
    return {
      operation: entry.operation,
      module: entry.module,
      authState: entry.authState,
      expected: entry.expected,
      actual: entry.actual,
      severity: 'CRITICAL',
      description: `${entry.operation} reached resolver without auth (UNAUTHENTICATED → BUSINESS_ERROR) — auth middleware bypassed`,
    };
  }

  // Case 1 (generic catch-all): expected DENY but got through
  if (entry.expected === 'DENY' && !entry.pass) {
    if (
      entry.actual === 'SCHEMA_VALIDATION_ERROR' ||
      entry.actual === 'VARIABLE_COERCION_ERROR' ||
      entry.actual === 'TIMEOUT_ERROR'
    ) {
      return null;
    }
    const isCritical = entry.authState === 'UNAUTHENTICATED';
    return {
      operation: entry.operation,
      module: entry.module,
      authState: entry.authState,
      expected: entry.expected,
      actual: entry.actual,
      severity: isCritical ? 'CRITICAL' : 'HIGH',
      description: isCritical
        ? `${entry.operation} allows unauthenticated access but should deny it`
        : `${entry.operation} allows ${entry.authState} access but should deny it`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default token resolver
// ---------------------------------------------------------------------------

/** Default token resolver: no tokens (caller injects tokenResolver for live runs). */
function defaultTokenResolver(_authState: string): Promise<string | null> {
  return Promise.resolve(null);
}

// ---------------------------------------------------------------------------
// Per-test execution (extracted for cognitive complexity)
// ---------------------------------------------------------------------------

/**
 * Record an entry in the result and update summary counters.
 * @internal Exported for invariant testing only.
 */
export function recordEntry(entry: RbacMatrixEntry, result: RbacMatrixResult): void {
  result.entries.push(entry);
  result.summary.totalTests++;
  result.summary.byAuthState[entry.authState].total++;
  if (entry.argsGuessed) {
    result.summary.argsGuessedCount++;
  }

  if (entry.inconclusive) {
    result.summary.inconclusive++;
    if (entry.actual === 'SCHEMA_VALIDATION_ERROR') result.summary.schemaValidationCount++;
    else if (entry.actual === 'VARIABLE_COERCION_ERROR') result.summary.variableCoercionCount++;
    else if (entry.actual === 'TIMEOUT_ERROR') result.summary.timeoutCount++;
    return;
  }

  if (entry.pass) {
    result.summary.passed++;
    result.summary.byAuthState[entry.authState].passed++;
    return;
  }

  result.summary.failed++;
  result.summary.byAuthState[entry.authState].failed++;
}

type RbacExecutor = (
  document: string,
  variables?: Record<string, unknown>,
  options?: { authToken?: string; headers?: Record<string, string> },
) => Promise<{ data: unknown; errors: Array<GraphQLError> | null; status: number | null }>;

type RbacLogger = { info: (msg: string) => void; warn: (msg: string) => void };

interface TestMutationContext {
  mutation: OperationInfo;
  authState: string;
  tokens: Map<string, string | null>;
  dryRun: boolean;
  safeMode: boolean;
  exec: RbacExecutor;
  result: RbacMatrixResult;
  expectations: ExpectationsMap;
  defaults: DefaultExpectationsMap;
  introspectionIndex?: Map<string, IntrospectionOperation>;
  typeMaps?: TypeMaps;
  clock: AgentClock;
  log: RbacLogger;
}

/** Resolve GraphQL args from introspection when available; tag when args are guessed. */
export function resolveRbacArgs(
  mutationName: string,
  introspectionIndex?: Map<string, IntrospectionOperation>,
  log?: RbacLogger,
): {
  args: Array<{ name: string; type: string; isRequired: boolean }>;
  returnType?: string;
  argsGuessed: boolean;
} {
  if (!introspectionIndex) {
    return { args: guessOperationArgs(mutationName), argsGuessed: true };
  }
  const introspectionOp = introspectionIndex.get(mutationName);
  if (!introspectionOp) {
    log?.warn(
      `[RbacMatrix] Operation "${mutationName}" not found in introspection — falling back to guessed args`,
    );
    return { args: guessOperationArgs(mutationName), argsGuessed: true };
  }
  return {
    args: introspectionOp.args.map((a) => ({
      name: a.name,
      type: a.type,
      isRequired: a.isRequired,
    })),
    returnType: introspectionOp.returnType,
    argsGuessed: false,
  };
}

async function testMutationForState(ctx: TestMutationContext): Promise<RbacMatrixEntry | null> {
  const { mutation, authState, tokens, dryRun, safeMode, exec, result, expectations, defaults } =
    ctx;
  const token = tokens.get(authState);

  // Skip auth states where we couldn't obtain a token (except UNAUTHENTICATED)
  if (authState !== 'UNAUTHENTICATED' && token === null) {
    result.summary.skipped++;
    return null;
  }

  const expected = getExpectation(mutation.name, authState, expectations, defaults);

  if (dryRun) {
    const entry: RbacMatrixEntry = {
      operation: mutation.name,
      module: mutation.module,
      authState,
      expected,
      actual: 'UNKNOWN_ERROR',
      interceptedBy: 'dry_run',
      pass: true, // Dry run — no actual execution, always "pass"
      inconclusive: false,
      errorMessage: null,
      durationMs: 0,
      argsGuessed: true,
    };
    recordEntry(entry, result);
    return entry;
  }

  // Resolve args and return type from introspection data, or guess the common pattern
  const resolved = resolveRbacArgs(mutation.name, ctx.introspectionIndex, ctx.log);

  // Build schema-valid operation (mutation or query) with variable declarations and stub values
  const smart = buildSmartMutation(
    mutation.name,
    resolved.args,
    resolved.returnType,
    ctx.typeMaps,
    mutation.type,
  );
  const authToken = authState === 'UNAUTHENTICATED' ? '' : (token ?? '');

  const elapsed = startTimer(ctx.clock);
  const response = await exec(smart.document, smart.variables, {
    authToken,
    headers: safeMode ? { 'X-Dino-Test': 'true' } : undefined,
  });
  const durationMs = elapsed();

  const actual = classifyResponse(response);
  const isInconclusive =
    actual === 'SCHEMA_VALIDATION_ERROR' ||
    actual === 'VARIABLE_COERCION_ERROR' ||
    actual === 'TIMEOUT_ERROR';
  const entry: RbacMatrixEntry = {
    operation: mutation.name,
    module: mutation.module,
    authState,
    expected,
    actual,
    interceptedBy: determineInterceptionLayer(actual),
    pass: isInconclusive ? true : evaluateResult(expected, actual),
    inconclusive: isInconclusive,
    errorMessage: (() => {
      const msg = response.errors?.[0]?.message ?? null;
      return msg == null ? null : sanitizeErrorMessage(msg);
    })(),
    durationMs,
    argsGuessed: resolved.argsGuessed,
  };

  recordEntry(entry, result);
  return entry;
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function logMatrixSummary(result: RbacMatrixResult, dryRun: boolean, log: RbacLogger): void {
  const layerCounts = result.entries.reduce(
    (acc, e) => {
      acc[e.interceptedBy] = (acc[e.interceptedBy] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const layerSummary = Object.entries(layerCounts)
    .map(([layer, count]) => `${layer}: ${count}`)
    .join(', ');

  log.info(
    `[RbacMatrix] Complete: ${result.summary.passed} passed, ` +
      `${result.summary.failed} failed, ${result.summary.inconclusive} inconclusive, ` +
      `${result.summary.skipped} skipped ` +
      `(${result.summary.totalTests} total${dryRun ? ', DRY RUN' : ''})`,
  );
  if (result.summary.schemaValidationCount > 0) {
    log.warn(
      `[RbacMatrix] ${result.summary.schemaValidationCount} tests blocked by schema ` +
        `validation — auth layer not reached (inconclusive)`,
    );
  }
  if (result.summary.variableCoercionCount > 0) {
    log.warn(
      `[RbacMatrix] ${result.summary.variableCoercionCount} tests blocked by variable ` +
        `coercion (BAD_USER_INPUT) — auth layer not reached (inconclusive)`,
    );
  }
  if (result.summary.timeoutCount > 0) {
    log.warn(
      `[RbacMatrix] ${result.summary.timeoutCount} tests timed out — ` +
        `auth layer status unknown (inconclusive)`,
    );
  }
  if (layerSummary) {
    log.info(`[RbacMatrix] Interception layers: ${layerSummary}`);
  }
  if (result.securityIssues.length > 0) {
    log.warn(
      `[RbacMatrix] SECURITY ISSUES DETECTED: ${result.securityIssues.length} operations ` +
        `may have auth enforcement gaps`,
    );
    for (const issue of result.securityIssues) {
      log.warn(`  [${issue.severity}] ${issue.description}`);
    }
  }
  if (result.summary.argsGuessedCount > 0) {
    log.warn(
      `[RbacMatrix] ${result.summary.argsGuessedCount} operation(s) used guessed args (not from introspection)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Run the full RBAC matrix: every mutation x every auth state.
 *
 * This is the primary agent tool. It:
 * 1. Extracts mutations from the provided registry
 * 2. For each mutation x auth state: builds minimal GQL, executes, classifies
 * 3. Compares against expectations
 * 4. Flags security issues (auth bypass)
 * 5. Returns structured report
 */
/** Default roles when tenant omits explicit `roles` in config. */
export const DEFAULT_ROLES = ['UNAUTHENTICATED', 'USER', 'ADMIN'];

/** Run the operation x auth-state matrix, populating result.entries and result.securityIssues. */
async function executeMatrix(
  operations: OperationInfo[],
  roles: string[],
  ctx: Omit<TestMutationContext, 'mutation' | 'authState'>,
): Promise<void> {
  for (const op of operations) {
    for (const authState of roles) {
      const entry = await testMutationForState({ ...ctx, mutation: op, authState });
      if (!entry) continue;
      const issue = detectSecurityIssue(entry);
      if (issue) ctx.result.securityIssues.push(issue);
    }
  }
}

export async function runRbacMatrix(options: RbacMatrixOptions): Promise<RbacMatrixResult> {
  const registry = options.registry;
  const dryRun = options.dryRun ?? false;
  const safeMode = options.safeMode ?? true;
  if (!dryRun && !options.executor) {
    throw new Error('executor required when not in dry-run mode');
  }
  let effectiveDryRun = dryRun;
  if (options.envName === 'production' && !dryRun && safeMode) {
    effectiveDryRun = true;
    (options.logger ?? NOOP_LOG).warn(
      '[RbacMatrix] Production detected with safeMode=true — forcing dry-run',
    );
  }
  const tokenResolver = options.tokenResolver ?? defaultTokenResolver;
  const exec =
    options.executor ??
    (() =>
      Promise.resolve({ data: null, errors: null, status: 0 } as {
        data: unknown;
        errors: Array<GraphQLError> | null;
        status: number | null;
      }));
  const roles = options.roles ?? DEFAULT_ROLES;
  const expectations = options.expectations ?? {};
  const defaults = options.defaultExpectations ?? {};
  const envName = options.envName ?? 'unknown';
  const log = options.logger ?? NOOP_LOG;
  const clock = resolveClock(options.clock);

  const result: RbacMatrixResult = {
    timestamp: clock.isoNow(),
    environment: envName,
    dryRun: effectiveDryRun,
    entries: [],
    securityIssues: [],
    summary: {
      totalTests: 0,
      passed: 0,
      failed: 0,
      inconclusive: 0,
      skipped: 0,
      schemaValidationCount: 0,
      variableCoercionCount: 0,
      timeoutCount: 0,
      byAuthState: {} as Record<string, { total: number; passed: number; failed: number }>,
      securityIssueCount: 0,
      argsGuessedCount: 0,
    },
  };

  // Initialize byAuthState counters
  for (const state of roles) {
    recordSet(result.summary.byAuthState, state, { total: 0, passed: 0, failed: 0 });
  }

  // 1. Extract operations (mutations and/or queries per options)
  const operations = extractOperations(
    registry,
    options.modules,
    options.operationTypes ?? ['mutation'],
  );
  log.info(
    `[RbacMatrix] ${operations.length} operations x ${roles.length} auth states = ${operations.length * roles.length} tests`,
  );

  if (operations.length === 0) {
    log.info('[RbacMatrix] No operations found. Nothing to test.');
    return result;
  }

  // 2. Resolve tokens upfront in parallel (one per auth state)
  const tokens = new Map<string, string | null>();
  const tokenEntries = await Promise.all(
    roles.map(async (state) => {
      try {
        const token = await tokenResolver(state);
        return [state, token] as const;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.securityIssues.push({
          operation: 'ALL_OPERATIONS',
          module: 'AUTH',
          authState: state,
          expected: 'UNKNOWN',
          actual: 'AUTH_ERROR',
          severity: 'HIGH',
          description: `Auth failure: failed to authenticate as ${state} — ${message}`,
        });
        return [state, null] as const;
      }
    }),
  );
  for (const [state, token] of tokenEntries) {
    tokens.set(state, token);
  }

  // 3. Pre-index introspection ops by name for O(1) lookup per test
  const introspectionIndex = options.introspectionData
    ? new Map(options.introspectionData.map((op) => [op.name, op]))
    : undefined;

  // 4. Run matrix
  await executeMatrix(operations, roles, {
    tokens,
    dryRun: effectiveDryRun,
    safeMode,
    exec,
    result,
    expectations,
    defaults,
    introspectionIndex,
    typeMaps: options.typeMaps,
    clock,
    log,
  });

  // 5. Finalize and log
  result.summary.securityIssueCount = result.securityIssues.length;
  logMatrixSummary(result, effectiveDryRun, log);

  return result;
}
