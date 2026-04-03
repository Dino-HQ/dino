/**
 * Project Dino — Input Fuzzer Engine (package)
 *
 * Sends malformed inputs to operations to verify input validation.
 * Registry and executor passed via options (host provides).
 *
 * @see Issue #7, #135
 */

import { recordSet } from '@dino/core';
import { sanitizeErrorMessage } from './_error-sanitizer';
import type { AgentClock, AgentTimer, AgentTimerHandle } from './shared/agent-clock';
import { resolveClock, startTimer, resolveTimer } from './shared/agent-clock';
import { parseRegistry } from './test-scaffolder';
import {
  type FuzzStrategyName,
  type FuzzInput,
  type ArgInfo,
  type FuzzStrategyOptions,
  QUICK_STRATEGIES,
  ALL_STRATEGIES,
  generateFuzzInputs,
} from './fuzz-strategies';
import { guessOperationArgs } from './query-builder';

export type FuzzResponseClass =
  | 'VALIDATION_ERROR'
  | 'VALIDATION_CORRECT'
  | 'SERVER_ERROR'
  | 'SILENT_FAILURE'
  | 'DATA_LEAK'
  | 'ACCEPTED';

export type FuzzMode = 'quick' | 'full';

export interface FuzzEntry {
  operation: string;
  module: string;
  strategy: FuzzStrategyName;
  label: string;
  classification: FuzzResponseClass;
  statusCode: number | null;
  errorMessage: string | null;
  durationMs: number;
}

export interface FuzzResult {
  timestamp: string;
  environment: string;
  mode: FuzzMode;
  dryRun: boolean;
  entries: FuzzEntry[];
  summary: {
    totalTests: number;
    validationErrors: number;
    validationCorrect: number;
    serverErrors: number;
    silentFailures: number;
    dataLeaks: number;
    accepted: number;
    byStrategy: Record<FuzzStrategyName, { total: number; passed: number; failed: number }>;
  };
}

export type FuzzExecutor = (
  document: string,
  variables?: Record<string, unknown>,
  options?: { authToken?: string },
) => Promise<{ data: unknown; errors: Array<{ message: string }> | null; status: number | null }>;

export interface FuzzOptions {
  mode?: FuzzMode;
  /** Operation registry (required). */
  registry: Record<string, string[]>;
  modules?: string[];
  dryRun?: boolean;
  executor?: FuzzExecutor;
  argResolver?: (operationName: string) => ArgInfo[];
  authToken?: string;
  envName?: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
  /** Per-request timeout in ms (default 10_000). */
  requestTimeout?: number;
  /** Total scan timeout in ms; aborts further iterations when exceeded (default 300_000). */
  scanTimeout?: number;
  /** Depth levels for DEPTH_ATTACK fuzz strategy. Default: [15, 30]. Max per level: 50. */
  depthAttackLevels?: number[];
  /** Injectable clock for deterministic timestamps. Default: SystemClock */
  clock?: AgentClock;
  /** Injectable timer for deterministic timeouts. Default: SystemTimer */
  timer?: AgentTimer;
}

const DATA_LEAK_PATTERNS = [
  /at\s+\S+\s+\(/i,
  /Error\s+at\s+line/i,
  /\/var\/www\//i,
  /node_modules\//i,
  /\/usr\/local\//i,
  /\/home\//i,
  /\\Users\\/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /MongoError/i,
  /MongoServerError/i,
  /PostgresError/i,
  /SQLITE_ERROR/i,
  /SequelizeError/i,
];

export function detectDataLeak(message: string): boolean {
  return DATA_LEAK_PATTERNS.some((pattern) => pattern.test(message));
}

export function classifyFuzzResponse(result: {
  data: unknown;
  errors: Array<{ message: string }> | null;
  status: number | null;
}): FuzzResponseClass {
  const errorMessages = (result.errors ?? []).map((e) => e.message).join(' ');
  if (errorMessages && detectDataLeak(errorMessages)) return 'DATA_LEAK';
  const status = result.status;
  if (status != null && status >= 500) return 'SERVER_ERROR';
  if (
    result.errors &&
    result.errors.length > 0 &&
    status != null &&
    status >= 400 &&
    status < 500
  ) {
    return 'VALIDATION_CORRECT';
  }
  if (result.errors && result.errors.length > 0) return 'VALIDATION_ERROR';
  if (result.data !== null && status != null && status >= 200 && status < 300) return 'ACCEPTED';
  if (result.data !== null) return 'SILENT_FAILURE';
  if (status != null && status >= 200 && status < 300) return 'ACCEPTED';
  return 'SILENT_FAILURE';
}

export function buildFuzzDocument(
  operationName: string,
  args: ArgInfo[],
  operationType: 'mutation' | 'query' = 'mutation',
): string {
  if (!operationName) return `${operationType} { __typename }`;
  const capitalName = operationName[0].toUpperCase() + operationName.slice(1);
  if (args.length === 0) return `${operationType} ${capitalName} { ${operationName} }`;
  const varDecls = args.map((a) => `$${a.name}: ${a.type}`).join(', ');
  const argPasses = args.map((a) => `${a.name}: $${a.name}`).join(', ');
  return `${operationType} ${capitalName}(${varDecls}) { ${operationName}(${argPasses}) }`;
}

const NOOP_LOG = { info: () => {}, warn: () => {} };

function buildDryRunEntry(opName: string, module: string, fuzzInput: FuzzInput): FuzzEntry {
  return {
    operation: opName,
    module,
    strategy: fuzzInput.strategy,
    label: fuzzInput.label,
    classification: 'VALIDATION_ERROR',
    statusCode: 0,
    errorMessage: null,
    durationMs: 0,
  };
}

/** @internal Exported for invariant testing only. */
export function updateSummary(summary: FuzzResult['summary'], entry: FuzzEntry): void {
  summary.totalTests++;
  summary.byStrategy[entry.strategy].total++;
  if (
    entry.classification === 'VALIDATION_ERROR' ||
    entry.classification === 'VALIDATION_CORRECT'
  ) {
    if (entry.classification === 'VALIDATION_ERROR') summary.validationErrors++;
    if (entry.classification === 'VALIDATION_CORRECT') summary.validationCorrect++;
    summary.byStrategy[entry.strategy].passed++;
  } else if (entry.classification === 'ACCEPTED') {
    summary.accepted++;
    summary.byStrategy[entry.strategy].passed++;
  } else {
    summary.byStrategy[entry.strategy].failed++;
    if (entry.classification === 'SERVER_ERROR') summary.serverErrors++;
    if (entry.classification === 'SILENT_FAILURE') summary.silentFailures++;
    if (entry.classification === 'DATA_LEAK') summary.dataLeaks++;
  }
}

interface ExecuteFuzzCaseOptions {
  opName: string;
  module: string;
  fuzzInput: FuzzInput;
  gql: string;
  exec: FuzzExecutor;
  authToken: string;
  requestTimeoutMs: number;
  clock: AgentClock;
  tmr: AgentTimer;
}

async function executeFuzzCase(opts: ExecuteFuzzCaseOptions): Promise<FuzzEntry> {
  const { opName, module, fuzzInput, gql, exec, authToken, requestTimeoutMs, clock, tmr } = opts;
  const elapsed = startTimer(clock);
  let timedOut = false;
  let handle: AgentTimerHandle | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    handle = tmr.setTimeout(() => {
      timedOut = true;
      reject(new Error('DINO_REQUEST_TIMEOUT'));
    }, requestTimeoutMs);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      handle.unref();
    }
  });
  let response: { data: unknown; errors: Array<{ message: string }> | null; status: number | null };
  try {
    response = await Promise.race([exec(gql, fuzzInput.variables, { authToken }), timeoutPromise]);
    if (timedOut) throw new Error('DINO_REQUEST_TIMEOUT');
  } catch (err) {
    const durationMs = elapsed();
    const message = err instanceof Error ? err.message : String(err);
    return {
      operation: opName,
      module,
      strategy: fuzzInput.strategy,
      label: fuzzInput.label,
      classification: 'SERVER_ERROR',
      statusCode: 0,
      errorMessage: sanitizeErrorMessage(message),
      durationMs,
    };
  } finally {
    if (handle !== undefined) tmr.clearTimeout(handle);
  }
  const durationMs = elapsed();
  const rawMessage = response.errors?.[0]?.message ?? null;
  return {
    operation: opName,
    module,
    strategy: fuzzInput.strategy,
    label: fuzzInput.label,
    classification: classifyFuzzResponse(response),
    statusCode: response.status,
    errorMessage: rawMessage == null ? null : sanitizeErrorMessage(rawMessage),
    durationMs,
  };
}

interface FuzzInputContext {
  op: ReturnType<typeof parseRegistry>[number];
  fuzzInputs: FuzzInput[];
  dryRun: boolean;
  gql: string;
  executor: FuzzExecutor;
  authToken: string;
  requestTimeout: number;
  result: FuzzResult;
  clock: AgentClock;
  timer: AgentTimer;
}

async function processFuzzInputs(ctx: FuzzInputContext): Promise<void> {
  const { op, fuzzInputs, dryRun, gql, executor, authToken, requestTimeout, result, clock, timer } =
    ctx;
  for (const fuzzInput of fuzzInputs) {
    if (dryRun) {
      const entry = buildDryRunEntry(op.name, op.module, fuzzInput);
      result.entries.push(entry);
      updateSummary(result.summary, entry);
    } else {
      const entry = await executeFuzzCase({
        opName: op.name,
        module: op.module,
        fuzzInput,
        gql,
        exec: executor,
        authToken,
        requestTimeoutMs: requestTimeout,
        clock,
        tmr: timer,
      });
      result.entries.push(entry);
      updateSummary(result.summary, entry);
    }
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SCAN_TIMEOUT_MS = 300_000;

/** Run all strategies for a single operation. Extracted to reduce CC of runInputFuzzer. */
async function fuzzSingleOperation(
  op: ReturnType<typeof parseRegistry>[number],
  strategies: readonly FuzzStrategyName[],
  resolveArgs: (name: string) => ArgInfo[],
  ctx: {
    depthAttackLevels?: number[];
    dryRun: boolean;
    executor: FuzzExecutor;
    authToken: string;
    requestTimeout: number;
    result: FuzzResult;
    isCancelled: () => boolean;
    clock: AgentClock;
    timer: AgentTimer;
  },
): Promise<void> {
  const args = resolveArgs(op.name);
  const gql = buildFuzzDocument(op.name, args, op.type as 'mutation' | 'query');
  for (const strategy of strategies) {
    if (ctx.isCancelled()) break;
    const strategyOptions: FuzzStrategyOptions | undefined = ctx.depthAttackLevels
      ? { depthAttackLevels: ctx.depthAttackLevels }
      : undefined;
    const fuzzInputs = generateFuzzInputs(strategy, args, strategyOptions);
    await processFuzzInputs({
      op,
      fuzzInputs,
      dryRun: ctx.dryRun,
      gql,
      executor: ctx.executor,
      authToken: ctx.authToken,
      requestTimeout: ctx.requestTimeout,
      result: ctx.result,
      clock: ctx.clock,
      timer: ctx.timer,
    });
  }
}

export async function runInputFuzzer(options: FuzzOptions): Promise<FuzzResult> {
  const mode = options.mode ?? 'full';
  const dryRun = options.dryRun ?? false;
  const resolveArgs = options.argResolver ?? guessOperationArgs;
  const authToken = options.authToken ?? '';
  const registry = options.registry;
  const envName = options.envName ?? 'unknown';
  const log = options.logger ?? NOOP_LOG;
  const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const scanTimeout = options.scanTimeout ?? DEFAULT_SCAN_TIMEOUT_MS;
  const depthAttackLevels = options.depthAttackLevels;
  const clock = resolveClock(options.clock);
  const tmr = resolveTimer(options.timer);

  const strategies: readonly FuzzStrategyName[] =
    mode === 'quick' ? QUICK_STRATEGIES : ALL_STRATEGIES;

  const result: FuzzResult = {
    timestamp: clock.isoNow(),
    environment: envName,
    mode,
    dryRun,
    entries: [],
    summary: {
      totalTests: 0,
      validationErrors: 0,
      validationCorrect: 0,
      serverErrors: 0,
      silentFailures: 0,
      dataLeaks: 0,
      accepted: 0,
      byStrategy: {} as Record<FuzzStrategyName, { total: number; passed: number; failed: number }>,
    },
  };

  for (const s of strategies) {
    recordSet(result.summary.byStrategy, s, { total: 0, passed: 0, failed: 0 });
  }

  const moduleFilter =
    options.modules && options.modules.length > 0 ? new Set(options.modules) : null;
  const operations = parseRegistry(registry)
    .filter((op) => op.type === 'mutation' || op.type === 'query')
    .filter((op) => !moduleFilter || moduleFilter.has(op.module));

  log.info(
    `[InputFuzzer] ${operations.length} operations x ${strategies.length} strategies (mode: ${mode})`,
  );

  if (operations.length === 0) {
    log.info('[InputFuzzer] No operations found. Nothing to fuzz.');
    return result;
  }

  const queryOps = operations.filter((op) => op.type === 'query');
  if (queryOps.length > 0) {
    log.info(`[InputFuzzer] Fuzzing ${queryOps.length} queries in addition to mutations`);
  }

  if (!dryRun && operations.length > 0 && !options.executor) {
    throw new Error('executor is required when not dryRun and operations exist');
  }
  const executor = options.executor!;

  let cancelled = false;
  const scanHandle = tmr.setTimeout(() => {
    cancelled = true;
  }, scanTimeout);
  if (typeof scanHandle === 'object' && scanHandle !== null && 'unref' in scanHandle) {
    scanHandle.unref();
  }

  try {
    for (const op of operations) {
      if (cancelled) break;
      await fuzzSingleOperation(op, strategies, resolveArgs, {
        depthAttackLevels,
        dryRun,
        executor,
        authToken,
        requestTimeout,
        result,
        isCancelled: () => cancelled,
        clock,
        timer: tmr,
      });
    }
  } finally {
    tmr.clearTimeout(scanHandle);
  }

  const { summary } = result;
  log.info(
    `[InputFuzzer] Complete: ${summary.totalTests} tests ` +
      `(${summary.validationErrors} validation errors, ${summary.validationCorrect} validated, ` +
      `${summary.serverErrors} server errors, ${summary.silentFailures} silent failures, ` +
      `${summary.dataLeaks} data leaks, ${summary.accepted} accepted` +
      `${result.dryRun ? ', DRY RUN' : ''})`,
  );

  return result;
}
