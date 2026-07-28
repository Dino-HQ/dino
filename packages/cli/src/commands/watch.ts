/**
 * @dino/cli — dino watch (scheduled scans + Shadow Mode). Issue #309.
 */

import {
  loadOperationRegistry,
  clearTenantCache,
  buildSnapshot,
  saveSnapshot,
  loadLatestSnapshot,
  diffSnapshots,
  runPipeline,
} from '@dino/engine';
import {
  resolveMaxIterations,
  validateAndBuildConfig,
  showIterationSummary,
  buildDegradedEntry,
  throwIfCircuitBroken,
  type IterationConfig,
  type WatchFlags,
} from './watch-helpers';
import { discoverOperations, withTracking } from '../shared/base-command';
import { saveHistoryEntry } from '../shared/history';
import { computeGlobalHealthScore, perOpFindingsFromEnv } from '../shared/pipeline-helpers';
import { detectUi, createSpinner } from '../shared/ui';
import type { CommandContext } from '../shared/base-command';
import type { WatchHistoryEntry } from '../shared/history';

export type { WatchFlags, AutonomyLevel } from './watch-helpers';

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_HISTORY_LIMIT = 100;

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

/* ------------------------------------------------------------------ */
/*  Iteration runner                                                   */
/* ------------------------------------------------------------------ */

/** Options for runIteration. */
interface RunIterationOptions {
  cfg: IterationConfig;
  iteration: number;
  quiet?: boolean | undefined;
  noColor?: boolean | undefined;
  nextSleepSec?: number | undefined;
}

async function executeIterationPipeline(cfg: IterationConfig, quiet?: boolean, noColor?: boolean) {
  const { context } = cfg;
  // B11 (#584): Clear tenant cache each iteration -- watch runs indefinitely,
  // registry may change between iterations. Stale cache -> stale module slugs.
  clearTenantCache();
  const ui = detectUi({ quiet, noColor });
  const discoverSpinner = createSpinner('Discovering operations\u2026', ui);
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
    perOpFindings: perOpFindingsFromEnv(),
    reasoningConfig: cfg.reasoningConfig,
    tracker: context.tracker,
    timeoutMs: cfg.timeoutMs,
    // B102 + B103: Share cache and circuit breaker across watch iterations
    circuitBreaker: cfg.circuitBreaker,
    reasoningCache: cfg.reasoningCache,
  });

  return { ops, result };
}

function buildIterationHistoryEntry(params: {
  ops: Awaited<ReturnType<typeof discoverOperations>>;
  result: Awaited<ReturnType<typeof runPipeline>>;
  context: CommandContext;
  healthScore: number;
  changes: { added: number; removed: number; modified: number; breakingChanges: number };
}): WatchHistoryEntry {
  const { ops, result, context, healthScore, changes } = params;
  return {
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
}

/** Execute one watch iteration. Returns exit code (1 for enforce breach) or null to continue. */
async function runIteration(opts: RunIterationOptions): Promise<number | null> {
  const { cfg, iteration, quiet, noColor, nextSleepSec } = opts;
  const { context } = cfg;

  const { ops, result } = await executeIterationPipeline(cfg, quiet, noColor);

  const snapshot = buildSnapshot({
    introspection: ops,
    tenantId: context.tenantId,
    environment: context.environment,
  });
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

  const entry = buildIterationHistoryEntry({ ops, result, context, healthScore, changes });
  await saveHistoryEntry(entry, { historyDir: cfg.historyDir, historyLimit: cfg.historyLimit });

  await showIterationSummary({
    iteration,
    context,
    entry,
    healthScore,
    changes,
    result,
    noColor,
    quiet,
    nextSleepSec,
  });

  if (cfg.autonomy === 'enforce' && diff && diff.summary.breakingChanges > 0) {
    console.error(
      `[enforce] ${diff.summary.breakingChanges} breaking change(s) detected \u2014 exiting with code 1`,
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
/*  Watch loop + public entry point                                    */
/* ------------------------------------------------------------------ */

async function executeWatchLoop(
  cfg: IterationConfig,
  flags: WatchFlags,
  intervalSec: number,
): Promise<number> {
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
        const exitCode = await runIteration({
          cfg,
          iteration,
          quiet: flags.quiet,
          noColor: flags.noColor,
          nextSleepSec: willSleepAgain ? intervalSec : undefined,
        });
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
}

export async function runWatch(context: CommandContext, flags: WatchFlags): Promise<number> {
  const intervalSec = Number(flags.interval ?? DEFAULT_INTERVAL_SECONDS);
  const historyLimit = Number(flags.historyLimit ?? DEFAULT_HISTORY_LIMIT);

  return withTracking({
    context,
    command: 'watch',
    flagsPayload: {
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
    quiet: flags.quiet,
    body: () => {
      const cfg = validateAndBuildConfig(context, flags, intervalSec, historyLimit);
      return executeWatchLoop(cfg, flags, intervalSec);
    },
  });
}
