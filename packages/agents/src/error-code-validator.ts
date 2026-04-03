/**
 * Project Dino — Error Code Consistency Validator
 *
 * Agent tool that validates GraphQL error code consistency across all operations.
 * Checks that same error scenarios produce same error codes/messages, and that
 * no error messages expose internal details (stack traces, file paths, etc.).
 *
 * Design:
 * - Tests each operation unauthenticated to collect error responses
 * - Catalogs unique error codes and messages
 * - Checks consistency: same scenario = same error code
 * - Detects information leakage in error messages
 * - DI pattern for testability (executor injectable)
 *
 * @example Agent usage:
 *   const result = await runErrorCodeValidator({ dryRun: true });
 *   // result.summary.inconsistent → operations with non-standard error codes
 *   // result.summary.leaks → operations exposing internal details
 *
 * @see Issue #11 — Error code consistency validation
 */

import { recordGet, recordSet } from '@dino/core';
import { sanitizeErrorMessage } from './_error-sanitizer';
import { guessOperationArgs, buildSmartMutation } from './query-builder';
import { parseRegistry } from './test-scaffolder';
import type { AgentClock } from './shared/agent-clock';
import { resolveClock } from './shared/agent-clock';

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorScenario = 'UNAUTHENTICATED' | 'BAD_INPUT' | 'NOT_FOUND';

export type OperationType = 'query' | 'mutation' | 'subscription';

export type ConsistencyClass = 'CONSISTENT' | 'INCONSISTENT' | 'LEAK' | 'NO_ERROR';

export interface ErrorCodeEntry {
  operation: string;
  module: string;
  type: OperationType;
  scenario: ErrorScenario;
  errorCode: string | null;
  errorMessage: string | null;
  classification: ConsistencyClass;
  hasStackTrace: boolean;
  hasFilePath: boolean;
  hasInternalDetail: boolean;
}

export interface ErrorCodeResult {
  timestamp: string;
  environment: string;
  dryRun: boolean;
  entries: ErrorCodeEntry[];
  uniqueCodes: string[];
  summary: {
    totalOperations: number;
    totalTests: number;
    consistent: number;
    inconsistent: number;
    leaks: number;
    noError: number;
    uniqueCodeCount: number;
  };
}

export interface ErrorCodeOptions {
  /** Error scenarios to test. Default: all. */
  scenarios?: ErrorScenario[];
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
  ) => Promise<{ data: unknown; errors: Array<{ message: string }> | null; status: number | null }>;
  /** Expected error codes per scenario. Overridable for testing. */
  expectedCodes?: Record<ErrorScenario, string[]>;
  envName?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error?: (msg: string) => void;
  };
  clock?: AgentClock;
}

// ---------------------------------------------------------------------------
// Information leak detection
// ---------------------------------------------------------------------------

const STACK_TRACE_PATTERNS = [/at\s+\S+\s+\(/i, /Error\s+at\s+line/i, /\.ts:\d+:\d+/];

const FILE_PATH_PATTERNS = [
  /\/var\/www\//i,
  /node_modules\//i,
  /\/usr\/local\//i,
  /\/home\//i,
  /\\Users\\/i,
  /\/src\//i,
  /\/dist\//i,
];

const INTERNAL_DETAIL_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /MongoError/i,
  /MongoServerError/i,
  /PostgresError/i,
  /SQLITE_ERROR/i,
  /SequelizeError/i,
  /INTERNAL_SERVER_ERROR/i,
  /Cannot read properties of/i,
  /TypeError:/i,
  /ReferenceError:/i,
];

function detectPattern(message: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(message));
}

export function detectStackTrace(message: string): boolean {
  return detectPattern(message, STACK_TRACE_PATTERNS);
}

export function detectFilePath(message: string): boolean {
  return detectPattern(message, FILE_PATH_PATTERNS);
}

export function detectInternalDetail(message: string): boolean {
  return detectPattern(message, INTERNAL_DETAIL_PATTERNS);
}

/**
 * Run all leak detection in a single pass and return flags.
 * Avoids running detectors twice (once in classify, once for flags).
 */
export interface LeakFlags {
  hasStackTrace: boolean;
  hasFilePath: boolean;
  hasInternalDetail: boolean;
  hasAnyLeak: boolean;
}

export function detectLeaks(message: string | null): LeakFlags {
  if (!message) {
    return {
      hasStackTrace: false,
      hasFilePath: false,
      hasInternalDetail: false,
      hasAnyLeak: false,
    };
  }
  const hasStackTrace = detectStackTrace(message);
  const hasFilePath = detectFilePath(message);
  const hasInternalDetail = detectInternalDetail(message);
  return {
    hasStackTrace,
    hasFilePath,
    hasInternalDetail,
    hasAnyLeak: hasStackTrace || hasFilePath || hasInternalDetail,
  };
}

// ---------------------------------------------------------------------------
// Expected error codes (NestJS/Apollo Server v4 conventions)
// ---------------------------------------------------------------------------

const DEFAULT_EXPECTED_CODES: Record<ErrorScenario, string[]> = {
  UNAUTHENTICATED: ['UNAUTHENTICATED'],
  BAD_INPUT: ['BAD_USER_INPUT', 'BAD_REQUEST', 'GRAPHQL_VALIDATION_FAILED'],
  NOT_FOUND: ['NOT_FOUND', 'RESOURCE_NOT_FOUND'],
};

// ---------------------------------------------------------------------------
// Query builder for error scenarios
// ---------------------------------------------------------------------------

/**
 * Build a syntactically valid query document with proper variable declarations.
 * Subscriptions are filtered out in runErrorCodeValidator before this is called.
 */
function buildValidDocument(
  operationName: string,
  operationType: 'query' | 'mutation',
): { query: string; stubVariables: Record<string, unknown> } {
  if (!operationName) {
    return { query: `${operationType} { __typename }`, stubVariables: {} };
  }
  const args = guessOperationArgs(operationName);
  if (args.length === 0) {
    const capitalName = operationName[0].toUpperCase() + operationName.slice(1);
    return {
      query: `${operationType} ErrorTest${capitalName} { ${operationName} }`,
      stubVariables: {},
    };
  }

  const smart = buildSmartMutation(operationName, args, undefined, undefined, operationType);
  return { query: smart.document, stubVariables: smart.variables };
}

// B86 (#655): removed tokenOverride param — BAD_INPUT/NOT_FOUND must use real auth
export function buildErrorTestQuery(
  operationName: string,
  operationType: 'query' | 'mutation',
  scenario: ErrorScenario,
): {
  query: string;
  variables: Record<string, unknown> | undefined;
  authToken: string | undefined;
} {
  const { query, stubVariables } = buildValidDocument(operationName, operationType);
  const hasArgs = Object.keys(stubVariables).length > 0;

  switch (scenario) {
    case 'UNAUTHENTICATED': {
      return {
        query,
        variables: hasArgs ? stubVariables : undefined,
        authToken: '',
      };
    }

    case 'BAD_INPUT': {
      if (!hasArgs) {
        return { query, variables: undefined, authToken: undefined };
      }
      const badVariables: Record<string, unknown> = {};
      for (const key of Object.keys(stubVariables)) {
        recordSet(badVariables, key, { __invalid: true, __scenario: 'BAD_INPUT' });
      }
      return { query, variables: badVariables, authToken: undefined };
    }

    case 'NOT_FOUND': {
      return buildNotFoundQuery(query, stubVariables, hasArgs);
    }
  }
}

function buildNotFoundQuery(
  query: string,
  stubVariables: Record<string, unknown>,
  hasArgs: boolean,
): {
  query: string;
  variables: Record<string, unknown> | undefined;
  authToken: string | undefined;
} {
  if (!hasArgs) {
    return { query, variables: undefined, authToken: undefined };
  }
  const notFoundVariables: Record<string, unknown> = {};
  for (const [key, stub] of Object.entries(stubVariables)) {
    if (stub && typeof stub === 'object') {
      recordSet(notFoundVariables, key, {
        ...(stub as Record<string, unknown>),
        id: 'non-existent-id-000000000000',
      });
    } else {
      recordSet(notFoundVariables, key, 'non-existent-id-000000000000');
    }
  }
  return { query, variables: notFoundVariables, authToken: undefined };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify an error response for consistency.
 *
 * Priority:
 * 1. LEAK — error message exposes internal details
 * 2. INCONSISTENT — error code doesn't match expected for scenario
 * 3. CONSISTENT — error code matches expected pattern
 * 4. NO_ERROR — no error returned (may indicate missing validation)
 */
export function classifyErrorResponse(
  scenario: ErrorScenario,
  errorCode: string | null,
  errorMessage: string | null,
  expectedCodes: Record<ErrorScenario, string[]>,
  leakFlags?: LeakFlags,
): ConsistencyClass {
  // No error at all
  if (!errorCode && !errorMessage) {
    return 'NO_ERROR';
  }

  // Check for information leaks (reuse pre-computed flags if provided)
  const leaks = leakFlags ?? detectLeaks(errorMessage);
  if (leaks.hasAnyLeak) {
    return 'LEAK';
  }

  // Check if code matches expected
  const expected = recordGet(expectedCodes, scenario) ?? [];
  if (errorCode && expected.includes(errorCode)) {
    return 'CONSISTENT';
  }

  // Has an error but code doesn't match expected
  if (errorCode) {
    return 'INCONSISTENT';
  }

  // Has an error message but no code — inconsistent
  return 'INCONSISTENT';
}

// ---------------------------------------------------------------------------
// Per-operation execution (extracted for cognitive complexity)
// ---------------------------------------------------------------------------

function buildDryRunEntry(
  opName: string,
  module: string,
  opType: 'query' | 'mutation',
  scenario: ErrorScenario,
): ErrorCodeEntry {
  return {
    operation: opName,
    module,
    type: opType,
    scenario,
    errorCode: null,
    errorMessage: null,
    classification: 'CONSISTENT',
    hasStackTrace: false,
    hasFilePath: false,
    hasInternalDetail: false,
  };
}

type ErrorCodeExecutor = (
  document: string,
  variables?: Record<string, unknown>,
  options?: { authToken?: string },
) => Promise<{ data: unknown; errors: Array<{ message: string }> | null; status: number | null }>;

async function executeErrorTest(
  opName: string,
  module: string,
  opType: 'query' | 'mutation',
  scenario: ErrorScenario,
  exec: ErrorCodeExecutor,
  expectedCodes: Record<ErrorScenario, string[]>,
): Promise<ErrorCodeEntry> {
  const { query, variables, authToken } = buildErrorTestQuery(opName, opType, scenario);

  try {
    const response = await exec(query, variables, { authToken });

    const firstError = response.errors?.[0] as
      | { message?: string; extensions?: Record<string, unknown> }
      | undefined;
    const errorCode = (firstError?.extensions?.['code'] as string) || null;
    const errorMessage = firstError?.message ?? null;

    // Single-pass leak detection — reused by both classify and entry flags
    const leaks = detectLeaks(errorMessage);
    const classification = classifyErrorResponse(
      scenario,
      errorCode,
      errorMessage,
      expectedCodes,
      leaks,
    );

    return {
      operation: opName,
      module,
      type: opType,
      scenario,
      errorCode,
      errorMessage,
      classification,
      hasStackTrace: leaks.hasStackTrace,
      hasFilePath: leaks.hasFilePath,
      hasInternalDetail: leaks.hasInternalDetail,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const leaks = detectLeaks(message);
    return {
      operation: opName,
      module,
      type: opType,
      scenario,
      errorCode: null,
      errorMessage: sanitizeErrorMessage(message),
      classification: leaks.hasAnyLeak ? 'LEAK' : 'INCONSISTENT',
      hasStackTrace: leaks.hasStackTrace,
      hasFilePath: leaks.hasFilePath,
      hasInternalDetail: leaks.hasInternalDetail,
    };
  }
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/** @internal Exported for invariant testing only. */
export function buildSummary(
  entries: ErrorCodeEntry[],
  uniqueCodes: string[],
): ErrorCodeResult['summary'] {
  let consistent = 0;
  let inconsistent = 0;
  let leaks = 0;
  let noError = 0;

  for (const entry of entries) {
    switch (entry.classification) {
      case 'CONSISTENT':
        consistent++;
        break;
      case 'INCONSISTENT':
        inconsistent++;
        break;
      case 'LEAK':
        leaks++;
        break;
      case 'NO_ERROR':
        noError++;
        break;
    }
  }

  // Count unique operations (not entries, which include multiple scenarios)
  const uniqueOps = new Set(entries.map((e) => e.operation));

  return {
    totalOperations: uniqueOps.size,
    totalTests: entries.length,
    consistent,
    inconsistent,
    leaks,
    noError,
    uniqueCodeCount: uniqueCodes.length,
  };
}

// ---------------------------------------------------------------------------
// Summary logging
// ---------------------------------------------------------------------------

function logErrorCodeSummary(
  result: ErrorCodeResult,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  const s = result.summary;
  log.info(
    `[ErrorCodeValidator] Complete: ${s.totalTests} tests across ${s.totalOperations} operations` +
      `${result.dryRun ? ' (DRY RUN)' : ''}`,
  );

  log.info(`[ErrorCodeValidator] Unique error codes: ${result.uniqueCodes.join(', ') || 'none'}`);

  if (s.consistent > 0) {
    log.info(`[ErrorCodeValidator] ${s.consistent} test(s) returned consistent error codes`);
  }

  if (s.inconsistent > 0) {
    log.warn(`[ErrorCodeValidator] ${s.inconsistent} test(s) returned inconsistent error codes`);
  }

  if (s.leaks > 0) {
    log.warn(`[ErrorCodeValidator] ${s.leaks} test(s) exposed internal details in error messages`);
  }

  if (s.noError > 0) {
    log.warn(`[ErrorCodeValidator] ${s.noError} test(s) returned no error (missing validation)`);
  }
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Run error code consistency validation across operations.
 *
 * This is the primary agent tool. It:
 * 1. Extracts operations from the provided registry
 * 2. For each operation + scenario: sends a request designed to trigger errors
 * 3. Catalogs error codes and checks consistency
 * 4. Detects information leakage in error messages
 * 5. Returns structured report
 */
export async function runErrorCodeValidator(options: ErrorCodeOptions): Promise<ErrorCodeResult> {
  const dryRun = options.dryRun ?? false;
  if (!dryRun && !options.executor) {
    throw new Error('executor required when not in dry-run mode');
  }
  const scenarios =
    options.scenarios ?? (['UNAUTHENTICATED', 'BAD_INPUT', 'NOT_FOUND'] as ErrorScenario[]);
  const exec = options.executor ?? (() => Promise.resolve({ data: null, errors: null, status: 0 }));
  const registry = options.registry;
  const expectedCodes = options.expectedCodes ?? DEFAULT_EXPECTED_CODES;
  const envName = options.envName ?? 'unknown';
  const log = options.logger ?? NOOP_LOG;
  const clock = resolveClock(options.clock);

  log.info(
    `[ErrorCodeValidator] Starting error code scan on ${envName} (${scenarios.length} scenarios)`,
  );

  // 1. Build operation list (exclude subscriptions — WebSocket transport, HTTP error codes don't apply)
  const allOps = parseRegistry(registry);
  const operations = allOps.filter(
    (op): op is typeof op & { type: 'query' | 'mutation' } => op.type !== 'subscription',
  );
  const moduleFilter =
    options.modules && options.modules.length > 0 ? new Set(options.modules) : null;
  const targetOps = operations.filter((op) => !moduleFilter || moduleFilter.has(op.module));

  log.info(`[ErrorCodeValidator] Testing ${targetOps.length} operations`);

  if (targetOps.length === 0) {
    const emptyResult: ErrorCodeResult = {
      timestamp: clock.isoNow(),
      environment: envName,
      dryRun,
      entries: [],
      uniqueCodes: [],
      summary: buildSummary([], []),
    };
    return emptyResult;
  }

  // 2. Execute tests
  const entries: ErrorCodeEntry[] = [];

  for (const op of targetOps) {
    for (const scenario of scenarios) {
      if (dryRun) {
        entries.push(buildDryRunEntry(op.name, op.module, op.type, scenario));
        continue;
      }

      const entry = await executeErrorTest(
        op.name,
        op.module,
        op.type,
        scenario,
        exec,
        expectedCodes,
      );
      entries.push(entry);
    }
  }

  // 3. Collect unique codes
  const codeSet = new Set<string>();
  for (const entry of entries) {
    if (entry.errorCode) {
      codeSet.add(entry.errorCode);
    }
  }
  const uniqueCodes = [...codeSet].sort((a, b) => a.localeCompare(b));

  // 4. Build result
  const result: ErrorCodeResult = {
    timestamp: clock.isoNow(),
    environment: envName,
    dryRun,
    entries,
    uniqueCodes,
    summary: buildSummary(entries, uniqueCodes),
  };

  // 5. Log summary
  logErrorCodeSummary(result, log);

  return result;
}
