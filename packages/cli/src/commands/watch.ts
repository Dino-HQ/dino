/**
 * @dino/cli - dino watch (scheduled scans + Shadow Mode). Issue #309.
 */

import { createRestExecutor } from '@dino/agents';
import { createPinnedFetch, partitionTools, type DinoResult } from '@dino/core';
import {
  loadOperationRegistry,
  clearTenantCache,
  buildSnapshot,
  saveSnapshot,
  loadLatestSnapshot,
  diffSnapshots,
  runPipeline,
  createFuzzerProjectionContext,
} from '@dino/engine';
import { buildAdHocRegistry } from './scan-helpers';
import { shouldFallBackToAdHocRegistry } from './scan-pipeline';
import {
  resolveMaxIterations,
  validateAndBuildConfig,
  showIterationSummary,
  buildDegradedEntry,
  throwIfCircuitBroken,
  type IterationConfig,
  type WatchFlags,
} from './watch-helpers';
import { discoverOperationsDetailed, getEndpoint, withTracking } from '../shared/base-command';
import { saveHistoryEntry } from '../shared/history';
import { discoveryRead } from '../shared/introspection-level';
import { outcomeKindFromIterationError, resolveExitCode } from '../shared/outcome';
import { detectUi, createSpinner, printNotice } from '../shared/ui';
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

/** Outcome of one watch iteration (honest exit uses the final iteration). */
type IterationOutcome = { kind: 'ok' } | { kind: 'partial' } | { kind: 'enforce' };

function buildWatchRestExecutor(
  context: CommandContext,
): ReturnType<typeof createRestExecutor> | undefined {
  // Mirror scan.ts:119-150 - pin fetch; merge context.authHeaders (per-call headers win).
  const base = createRestExecutor({
    fetch: createPinnedFetch({ allowPrivateTarget: context.allowPrivateTarget === true }),
  });
  const staticHeaders = context.authHeaders;
  if (staticHeaders === undefined || Object.keys(staticHeaders).length === 0) {
    return base;
  }
  return (operation: Parameters<typeof base>[0], options: Parameters<typeof base>[1]) =>
    base(operation, {
      ...options,
      headers: { ...staticHeaders, ...options.headers },
    });
}

async function executeIterationPipeline(cfg: IterationConfig, quiet?: boolean, noColor?: boolean) {
  // The target was resolved and ADMITTED once, at context creation. Re-resolving it per iteration
  // re-decided a settled question against a policy this call did not have, so a loopback target the
  // command had already accepted was refused again before the first iteration. `protected` is
  // already normalised on the resolved target, so the second pass was adding nothing either.
  const context = cfg.context;
  // B11 (#584): Clear tenant cache each iteration -- watch runs indefinitely,
  // registry may change between iterations. Stale cache -> stale module slugs.
  clearTenantCache();
  const ui = detectUi({ quiet, noColor });
  const discoverSpinner = createSpinner('Discovering operations\u2026', ui);
  discoverSpinner.start();
  let ops: Awaited<ReturnType<typeof discoverOperationsDetailed>>;
  try {
    ops = await discoverOperationsDetailed(context);
    discoverSpinner.succeed(`Found ${ops.discoveredOperations.length} operations`);
  } catch (err) {
    discoverSpinner.fail('Discovery failed');
    throw err;
  }

  const useAdHoc = shouldFallBackToAdHocRegistry(context);
  const registry = useAdHoc
    ? buildAdHocRegistry(ops.graphqlOperations, context.tenantId)
    : loadOperationRegistry(context.tenantId);

  const restOperations = ops.discoveredOperations.filter((o) => o.type === 'rest');
  const hasRest = restOperations.length > 0;
  const endpoint = hasRest ? getEndpoint(context) : undefined;

  const result = await runPipeline({
    targets: { graphql: context.selectedTarget, rest: context.selectedTarget },
    tenantId: context.tenantId,
    environment: context.environment,
    trigger: 'watch',
    registry,
    executor: cfg.executor,
    tokenResolver: cfg.tokenResolver,
    rbacRoles: cfg.rbacRoles,
    tools: cfg.validatedTools,
    modules: cfg.validatedModules,
    tracker: context.tracker,
    timeoutMs: cfg.timeoutMs,
    restExecutor: hasRest ? buildWatchRestExecutor(context) : undefined,
    restBaseUrl: endpoint,
    openApiSpec: hasRest ? ops.discoveryRaw : undefined,
    restOperations: hasRest ? restOperations : undefined,
    ...(ops.introspectionLevel === undefined ? {} : { introspectionLevel: ops.introspectionLevel }),
    // Read only by the shadow DinoResult constructor (Cleanup V2 task 2); tool inputs are unchanged.
    discovery: { graphqlOperations: ops.graphqlOperations, introspectionLevel: ops.introspectionLevel, read: discoveryRead({ structureSource: ops.structureSource, hasRest }) },
  }, createFuzzerProjectionContext());
  return { ops, result };
}

/** Every field is a copy of the canonical result (Cleanup V2 task 4c); only the schema diff is the host's. */
function buildIterationHistoryEntry(params: {
  result: DinoResult;
  changes: { added: number; removed: number; modified: number; breakingChanges: number };
}): WatchHistoryEntry {
  const { result, changes } = params;
  const tools = result.verification.tools;
  const partition = partitionTools(tools);
  return {
    runId: result.identity.runId,
    timestamp: result.identity.generatedAt,
    tenantId: result.identity.tenantId,
    environment: result.identity.environment,
    trigger: 'watch',
    durationMs: result.verification.durationMs,
    operationCount: result.verdict.operationCount,
    toolsRun: tools.filter((t) => t.status === 'ran').length,
    toolsCompleted: partition.completed.length,
    toolsFailed: partition.failed.length,
    degraded: result.verdict.degraded,
    healthScore: result.verdict.health.score,
    schemaChanges: {
      added: changes.added,
      removed: changes.removed,
      modified: changes.modified,
      breakingChanges: changes.breakingChanges,
    },
  };
}

/** Execute one watch iteration. */
async function runIteration(opts: RunIterationOptions): Promise<IterationOutcome> {
  const { cfg, iteration, quiet, noColor, nextSleepSec } = opts;
  const { context } = cfg;

  const { ops, result } = await executeIterationPipeline(cfg, quiet, noColor);

  const restOperations = ops.discoveredOperations.filter((o) => o.type === 'rest');
  const snapshot = buildSnapshot({
    introspection: ops.graphqlOperations,
    restOperations,
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

  const changes = diff?.summary ?? { added: 0, removed: 0, modified: 0, breakingChanges: 0 };

  const entry = buildIterationHistoryEntry({ result, changes });
  await saveHistoryEntry(entry, { historyDir: cfg.historyDir, historyLimit: cfg.historyLimit });

  await showIterationSummary({
    iteration,
    context,
    entry,
    // Health is copied from the canonical verdict — never recomputed from a catalog rebuild.
    health: result.verdict.health,
    changes,
    result: { durationMs: result.verification.durationMs, degraded: result.verdict.degraded },
    noColor,
    quiet,
    nextSleepSec,
  });

  if (cfg.autonomy === 'enforce' && diff && diff.summary.breakingChanges > 0) {
    const ui = detectUi({ quiet, noColor });
    printNotice(
      `[enforce] ${diff.summary.breakingChanges} breaking change(s) detected: exiting with code 3`,
      ui,
    );
    return { kind: 'enforce' };
  }
  // The verdict's own partial (incomplete verification, degraded included) is a declared partial outcome.
  if (result.verdict.coverage === 'partial') {
    return { kind: 'partial' };
  }
  return { kind: 'ok' };
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
  }).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/*  Watch loop + public entry point                                    */
/* ------------------------------------------------------------------ */

interface WatchLoopState {
  consecutiveFailures: number;
  terminal: { kind: 'ok' } | { kind: 'partial' } | { kind: 'caught'; error: unknown };
}

function applyIterationOutcome(state: WatchLoopState, outcome: IterationOutcome): number | null {
  // enforce = policy breach (breaking changes) → exit 3, no envelope
  if (outcome.kind === 'enforce') return resolveExitCode({ kind: 'policy' });
  if (outcome.kind === 'ok') {
    state.terminal = { kind: 'ok' };
    state.consecutiveFailures = 0;
  } else {
    // partial verdict → partial declared outcome (exit 6)
    state.terminal = { kind: 'partial' };
    state.consecutiveFailures = 0;
  }
  return null;
}

function resolveTerminalExit(terminal: WatchLoopState['terminal']): number {
  switch (terminal.kind) {
    case 'ok':
      return 0;
    case 'partial':
      return resolveExitCode({ kind: 'partial' });
    case 'caught':
      throw terminal.error;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing watch interrupt/circuit loop; unchanged by Sonar import cleanup
async function executeWatchLoop(
  cfg: IterationConfig,
  flags: WatchFlags,
  intervalSec: number,
): Promise<number> {
  const maxIterations = resolveMaxIterations(flags);
  let iteration = 0;
  let interrupted = false;
  const state: WatchLoopState = {
    consecutiveFailures: 0,
    terminal: { kind: 'ok' },
  };
  let pendingSleep: { cancel: () => void } | null = null;
  const onShutdown = (): void => {
    interrupted = true;
    pendingSleep?.cancel();
  };
  process.on('SIGINT', onShutdown);
  process.on('SIGTERM', onShutdown);

  try {
    while (!interrupted && iteration < maxIterations) {
      iteration++;
      try {
        const willSleepAgain = !interrupted && iteration < maxIterations;
        const outcome = await runIteration({
          cfg,
          iteration,
          quiet: flags.quiet,
          noColor: flags.noColor,
          nextSleepSec: willSleepAgain ? intervalSec : undefined,
        });
        const early = applyIterationOutcome(state, outcome);
        if (early !== null) return early;
      } catch (iterError) {
        state.terminal = { kind: 'caught', error: iterError };
        if (outcomeKindFromIterationError(iterError) !== 'transient') throw iterError;
        state.consecutiveFailures++;
        await handleIterationError(iterError, iteration, cfg, flags.quiet);
        throwIfCircuitBroken(state.consecutiveFailures, cfg, iterError);
      }

      if (!interrupted && iteration < maxIterations) {
        const sleeper = cancellableSleep(intervalSec * 1000);
        pendingSleep = sleeper;
        await sleeper.promise;
        pendingSleep = null;
      }
    }
    return resolveTerminalExit(state.terminal);
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
