/**
 * @dino/cli — dino watch (scheduled scans + Shadow Mode). Issue #309.
 */

import type { CommandContext, CommonFlags } from '../shared/base-command';
import { getEndpoint, discoverOperations, withTracking } from '../shared/base-command';
import { CliError } from '../shared/errors';
import { detectUi, createSpinner, healthLabel, durationLabel, colorize } from '../shared/ui';
import { shouldRenderInkView } from '../ink/render';
import { loadOperationRegistry, clearTenantCache } from '@reporters/operation-mapper';
import { buildSnapshot, saveSnapshot, loadLatestSnapshot, diffSnapshots } from '@intelligence';
import { runPipeline } from '@pipeline/runner';
import { saveHistoryEntry } from '../shared/history';
import type { WatchHistoryEntry } from '../shared/history';
import path from 'node:path';
import { safePath } from '@utils/safe-path';
import type { TokenResolver } from '../../../../src/pipeline/runner.types';
import {
  DEFAULT_REASONING_OPTS,
  validateTools,
  validateModules,
  createExecutor,
  withAuth,
  buildTokenResolver,
  validateRbacRoles,
  validateConfigConsistency,
  computeGlobalHealthScore,
} from '../shared/pipeline-helpers';
import { createTokenFactory } from '@shared/auth/token-factory';
import { createAuthAdapter } from '@shared/auth/adapter-factory';

export interface WatchFlags extends CommonFlags {
  interval?: number;
  iterations?: number;
  /** Shorthand for --iterations 1. Run once and exit. Designed for CI pipelines. */
  once?: boolean;
  /** CLI: string (e.g. 'observe'); config: object (e.g. { level: 'observe' }). Resolved by resolveAutonomy(). */
  autonomy?: string | { level: string };
  historyLimit?: number;
  snapshotDir?: string;
  tools?: string[];
  modules?: string[];
  reasoning?: boolean;
  aiKey?: string;
  timeout?: number;
  auth?: { enabled: boolean; role?: string };
  /** Maximum consecutive iteration failures before exiting non-zero (default 5). */
  maxConsecutiveFailures?: number;
}

export type AutonomyLevel = 'observe' | 'enforce';

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_DIR = '.dino/history';
const DEFAULT_SNAPSHOT_DIR = '.dino/snapshots';
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const VALID_AUTONOMY_LEVELS: ReadonlySet<string> = new Set(['observe', 'enforce']);

/** Returns a cancellable sleep. Call cancel() to resolve immediately (B26 #606). */
function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  let resolveFn: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
    timer = setTimeout(resolve, ms); // determinism:allowed
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
      resolveFn();
    },
  };
}

function validateInterval(interval: number): void {
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new CliError(
      `Invalid interval: ${interval}. Must be a positive number of seconds.`,
      1,
      'Use a positive number of seconds, e.g. --interval 300.',
    );
  }
}

function resolveAutonomy(flags: WatchFlags): AutonomyLevel {
  const raw = flags.autonomy;
  let level: string;
  if (typeof raw === 'string') {
    level = raw;
  } else if (raw && typeof raw === 'object' && 'level' in raw) {
    level = (raw as { level: string }).level;
  } else {
    level = 'observe';
  }
  if (!VALID_AUTONOMY_LEVELS.has(level)) {
    console.warn(`Unknown autonomy level "${level}", defaulting to "observe".`);
    return 'observe';
  }
  return level as AutonomyLevel;
}

function resolveMaxIterations(flags: WatchFlags): number {
  if (flags.once) return 1;
  if (flags.iterations != null) {
    const n = Number(flags.iterations);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      throw new CliError(
        `Invalid --iterations: "${flags.iterations}". Must be a positive integer.`,
        1,
        'Use a positive integer, e.g. --iterations 5.',
      );
    }
    return n;
  }
  return Infinity;
}

function buildReasoningConfig(reasoning: boolean | undefined, aiKey: string | undefined) {
  if (reasoning) {
    return { ...DEFAULT_REASONING_OPTS, enabled: true as const, apiKey: aiKey! };
  }
  return { ...DEFAULT_REASONING_OPTS, enabled: false as const, apiKey: null };
}

function buildExecutor(
  context: CommandContext,
  auth?: WatchFlags['auth'],
): { executor: ReturnType<typeof createExecutor>; tokenResolver?: TokenResolver } {
  const endpoint = getEndpoint(context);
  const base = createExecutor(endpoint);
  if (auth?.enabled) {
    const tokenFactory = createTokenFactory({
      endpoint,
      tenantId: context.tenantId,
      adapter: createAuthAdapter(context.tenantConfig.auth),
      refreshBufferMs: (context.tenantConfig.auth?.tokenRefresh?.expiryBuffer ?? 60) * 1000,
    });
    const executor = withAuth(base, tokenFactory, auth.role ?? 'USER');
    const tokenResolver = buildTokenResolver(tokenFactory);
    return { executor, tokenResolver };
  }
  console.warn(
    '⚠️  No auth config — running unauthenticated. RBAC matrix will only test UNAUTHENTICATED role.',
  );
  return { executor: base };
}

function buildDegradedEntry(iteration: number, context: CommandContext): WatchHistoryEntry {
  return {
    runId: `degraded-${iteration}-${Date.now()}`, // determinism:allowed
    timestamp: new Date().toISOString(), // determinism:allowed
    tenantId: context.tenantId,
    environment: context.environment,
    trigger: 'watch',
    durationMs: 0,
    operationCount: 0,
    toolsRun: 0,
    toolsCompleted: 0,
    toolsFailed: 0,
    degraded: true,
    healthScore: 0,
    schemaChanges: { added: 0, removed: 0, modified: 0, breakingChanges: 0 },
  };
}

/** Pure predicate: has the consecutive-failure threshold been reached? */
function isCircuitBroken(consecutiveFailures: number, cfg: IterationConfig): boolean {
  return consecutiveFailures >= cfg.maxConsecutiveFailures;
}

/** Throw CliError if the circuit breaker threshold has been reached. */
function throwIfCircuitBroken(
  consecutiveFailures: number,
  cfg: IterationConfig,
  iterError: unknown,
): void {
  if (!isCircuitBroken(consecutiveFailures, cfg)) return;
  const msg = iterError instanceof Error ? iterError.message : String(iterError);
  throw new CliError(
    `[watch] ${consecutiveFailures} consecutive failures — exiting. Last error: ${msg}`,
  );
}

/* ------------------------------------------------------------------ */
/*  Iteration runner (extracted to reduce cognitive complexity)        */
/* ------------------------------------------------------------------ */

interface IterationConfig {
  context: CommandContext;
  executor: ReturnType<typeof createExecutor>;
  tokenResolver?: TokenResolver;
  rbacRoles?: string[];
  autonomy: AutonomyLevel;
  validatedTools?: ReturnType<typeof validateTools>;
  validatedModules?: string[];
  reasoningConfig: ReturnType<typeof buildReasoningConfig>;
  snapshotDir: string;
  timeoutMs: number;
  historyDir: string;
  historyLimit: number;
  maxConsecutiveFailures: number;
  /** Seconds until next iteration (for Ink countdown when another loop is scheduled). */
  intervalSec: number;
  // B102 (#671) + B103 (#672): Shared across iterations so watch mode preserves state
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import() required: top-level @dino/reasoning import is restricted (CLI bundle)
  circuitBreaker?: import('@dino/reasoning').CircuitBreaker;
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import() required: top-level @dino/reasoning import is restricted (CLI bundle)
  reasoningCache?: import('@dino/reasoning').ReasoningCache;
}

/** Execute one watch iteration. Returns exit code (1 for enforce breach) or null to continue. */
async function runIteration(
  cfg: IterationConfig,
  iteration: number,
  quiet?: boolean,
  noColor?: boolean,
  nextSleepSec?: number,
): Promise<number | null> {
  const { context } = cfg;
  // B11 (#584): Clear tenant cache each iteration — watch runs indefinitely,
  // registry may change between iterations. Stale cache → stale module slugs.
  clearTenantCache();
  const ui = detectUi({ quiet, noColor });
  const discoverSpinner = createSpinner('Discovering operations…', ui);
  discoverSpinner.start();
  let ops;
  try {
    ops = await discoverOperations(context);
    discoverSpinner.succeed(`Found ${ops.length} operations`);
  } catch (err) {
    discoverSpinner.fail('Discovery failed');
    throw err;
  }
  const result = await runPipeline({
    tenantId: context.tenantId,
    environment: context.environment,
    trigger: 'watch',
    registry: loadOperationRegistry(context.tenantId),
    executor: cfg.executor,
    tokenResolver: cfg.tokenResolver,
    rbacRoles: cfg.rbacRoles,
    tools: cfg.validatedTools,
    modules: cfg.validatedModules,
    reasoningConfig: cfg.reasoningConfig,
    tracker: context.tracker,
    timeoutMs: cfg.timeoutMs,
    // B102 + B103: Share cache and circuit breaker across watch iterations
    circuitBreaker: cfg.circuitBreaker,
    reasoningCache: cfg.reasoningCache,
  });

  const snapshot = buildSnapshot(ops, context.tenantId, context.environment);
  const snapshotOpts = {
    snapshotDir: cfg.snapshotDir,
    tenantId: context.tenantId,
    environment: context.environment,
  };
  const prev = await loadLatestSnapshot(snapshotOpts);
  const diff = prev ? diffSnapshots(prev, snapshot) : null;
  await saveSnapshot(snapshot, snapshotOpts);

  const healthScore = computeGlobalHealthScore(result.condensed);
  const changes = diff?.summary ?? { added: 0, removed: 0, modified: 0, breakingChanges: 0 };

  const entry: WatchHistoryEntry = {
    runId: result.runId,
    timestamp: new Date().toISOString(), // determinism:allowed
    tenantId: context.tenantId,
    environment: context.environment,
    trigger: 'watch',
    durationMs: result.durationMs,
    operationCount: ops.length,
    toolsRun: result.metadata.toolsRun.length,
    toolsCompleted: result.metadata.toolsCompleted.length,
    toolsFailed: result.metadata.toolsFailed.length,
    degraded: result.metadata.degraded,
    healthScore,
    schemaChanges: {
      added: changes.added,
      removed: changes.removed,
      modified: changes.modified,
      breakingChanges: changes.breakingChanges,
    },
  };
  await saveHistoryEntry(entry, { historyDir: cfg.historyDir, historyLimit: cfg.historyLimit });

  if (!quiet) {
    const summaryUi = detectUi({ quiet, noColor });
    let inkShown = false;
    if (shouldRenderInkView(summaryUi, { quiet })) {
      try {
        const React = await import('react');
        const { renderViewSafe } = await import('../ink/render');
        const { WatchIterationView } = await import('../views/WatchIterationView');
        const { CLI_VERSION } = await import('../version');
        inkShown = renderViewSafe(
          React.createElement(WatchIterationView, {
            version: CLI_VERSION,
            tenant: context.tenantId,
            environment: context.environment,
            iteration,
            healthScore,
            operationCount: entry.operationCount,
            toolsRun: entry.toolsRun,
            toolsCompleted: entry.toolsCompleted,
            toolsFailed: entry.toolsFailed,
            breakingChanges: changes.breakingChanges,
            durationMs: result.durationMs,
            degraded: Boolean(result.metadata.degraded),
            nextScanInSec: nextSleepSec,
            colored: summaryUi.colored,
          }),
        );
      } catch (inkErr) {
        console.warn(
          '[dino] Ink watch view failed:',
          inkErr instanceof Error ? inkErr.message : String(inkErr),
        );
        inkShown = false;
      }
    }
    if (!inkShown) {
      const lines = [
        '',
        colorize(`── Iteration ${iteration} — ${context.environment} ──`, 'dim', summaryUi),
        `  Health:     ${healthLabel(healthScore, summaryUi)}`,
        `  Operations: ${entry.operationCount}`,
        `  Tools:      ${entry.toolsRun} run, ${entry.toolsCompleted} completed, ${entry.toolsFailed} failed`,
        `  Breaking:   ${changes.breakingChanges > 0 ? colorize(`${changes.breakingChanges} breaking`, 'redBold', summaryUi) : colorize('0', 'green', summaryUi)}`,
        `  Duration:   ${colorize(durationLabel(result.durationMs), 'dim', summaryUi)}`,
      ];
      if (result.metadata.degraded) {
        const degradedMsg = '⚠  Degraded — all tools failed. Health score may be unreliable.';
        lines.push(`  ${colorize(degradedMsg, 'yellow', summaryUi)}`);
      }
      lines.push('');
      console.info(lines.join('\n'));
    }
  }

  if (cfg.autonomy === 'enforce' && diff && diff.summary.breakingChanges > 0) {
    console.error(
      `[enforce] ${diff.summary.breakingChanges} breaking change(s) detected — exiting with code 1`,
    );
    return 1;
  }
  return null;
}

/** Log + persist a degraded iteration entry. */
async function handleIterationError(
  error: unknown,
  iteration: number,
  cfg: IterationConfig,
  quiet?: boolean,
): Promise<void> {
  if (!quiet) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[watch] iteration ${iteration} failed:`, msg);
  }
  await saveHistoryEntry(buildDegradedEntry(iteration, cfg.context), {
    historyDir: cfg.historyDir,
    historyLimit: cfg.historyLimit,
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  Validation + config builder (extracted for cognitive complexity)    */
/* ------------------------------------------------------------------ */

function validateAndBuildConfig(
  context: CommandContext,
  flags: WatchFlags,
  intervalSec: number,
  historyLimit: number,
): IterationConfig {
  validateInterval(intervalSec);
  // B12 (#585): Validate iterations — NaN causes silent exit
  resolveMaxIterations(flags); // validates; caller uses return value separately
  // B13 (#586): Validate historyLimit — NaN causes unbounded disk growth
  if (!Number.isFinite(historyLimit) || historyLimit < 1 || !Number.isInteger(historyLimit)) {
    throw new CliError(
      `Invalid --history-limit: "${flags.historyLimit}". Must be a positive integer.`,
    );
  }
  const maxConsecutiveFailures = Number(
    flags.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
  );
  if (
    !Number.isFinite(maxConsecutiveFailures) ||
    maxConsecutiveFailures < 1 ||
    !Number.isInteger(maxConsecutiveFailures)
  ) {
    throw new CliError(
      `Invalid --max-consecutive-failures: "${flags.maxConsecutiveFailures}". Must be a positive integer.`,
    );
  }
  const autonomy = resolveAutonomy(flags);
  const validatedTools = flags.tools ? validateTools(flags.tools) : undefined;
  const validatedModules = flags.modules
    ? validateModules(flags.modules, context.tenantId)
    : undefined;
  const aiKey = flags.aiKey ?? process.env.DINO_AI_KEY;
  if (flags.reasoning && !aiKey) {
    throw new CliError(
      'AI reasoning requires an API key. Set DINO_AI_KEY env var or add aiKey to .dino.yml',
    );
  }

  const { executor, tokenResolver } = buildExecutor(context, flags.auth);

  const rbacRoles: string[] | undefined = (context.tenantConfig as { rbac?: { roles?: string[] } })
    .rbac?.roles;
  if (!flags.quiet && (!rbacRoles || rbacRoles.length === 0)) {
    console.info(
      'No rbac.roles in tenant config — skipping RBAC matrix. Add an rbac: section to your tenant YAML to enable.',
    );
  }
  if (rbacRoles) {
    validateRbacRoles(rbacRoles, context.tenantConfig.auth?.roles);
  }
  if (rbacRoles && context.tenantConfig.auth?.roles) {
    validateConfigConsistency(rbacRoles, context.tenantConfig.auth.roles);
  }

  return {
    context,
    executor,
    tokenResolver,
    rbacRoles,
    autonomy,
    validatedTools,
    validatedModules,
    reasoningConfig: buildReasoningConfig(flags.reasoning, aiKey),
    snapshotDir: flags.snapshotDir ? safePath(flags.snapshotDir) : DEFAULT_SNAPSHOT_DIR,
    timeoutMs: flags.timeout ?? 300_000,
    historyDir: path.join(process.cwd(), DEFAULT_HISTORY_DIR),
    historyLimit,
    maxConsecutiveFailures,
    intervalSec,
  };
}

/* ------------------------------------------------------------------ */
/*  Public entry point                                                 */
/* ------------------------------------------------------------------ */

export async function runWatch(context: CommandContext, flags: WatchFlags): Promise<number> {
  const intervalSec = Number(flags.interval ?? DEFAULT_INTERVAL_SECONDS);
  const historyLimit = Number(flags.historyLimit ?? DEFAULT_HISTORY_LIMIT);

  return withTracking(
    context,
    'watch',
    {
      tenant: flags.tenant,
      env: flags.env,
      interval: intervalSec,
      iterations: flags.iterations,
      autonomy: flags.autonomy,
      historyLimit,
      maxConsecutiveFailures: flags.maxConsecutiveFailures,
      debug: flags.debug,
      noColor: flags.noColor,
    },
    flags.quiet,
    async () => {
      const cfg = validateAndBuildConfig(context, flags, intervalSec, historyLimit);
      const maxIterations = resolveMaxIterations(flags);

      let iteration = 0;
      let consecutiveFailures = 0;
      let interrupted = false;
      let pendingSleep: { cancel: () => void } | null = null;
      const onShutdown = (): void => {
        interrupted = true;
        // B26 (#606): Cancel pending sleep immediately on Ctrl+C / SIGTERM
        pendingSleep?.cancel();
      };
      process.on('SIGINT', onShutdown);
      // B106 (#675): Handle SIGTERM for graceful shutdown in containers
      process.on('SIGTERM', onShutdown);

      try {
        while (!interrupted && iteration < maxIterations) {
          iteration++;
          try {
            const willSleepAgain = !interrupted && iteration < maxIterations;
            const exitCode = await runIteration(
              cfg,
              iteration,
              flags.quiet,
              flags.noColor,
              willSleepAgain ? intervalSec : undefined,
            );
            if (exitCode !== null) return exitCode;
            consecutiveFailures = 0;
          } catch (iterError) {
            consecutiveFailures++;
            await handleIterationError(iterError, iteration, cfg, flags.quiet);
            throwIfCircuitBroken(consecutiveFailures, cfg, iterError);
          }

          if (!interrupted && iteration < maxIterations) {
            const sleeper = cancellableSleep(intervalSec * 1000);
            pendingSleep = sleeper;
            await sleeper.promise;
            pendingSleep = null;
          }
        }
        return 0;
      } finally {
        process.removeListener('SIGINT', onShutdown);
        process.removeListener('SIGTERM', onShutdown);
      }
    },
  );
}
