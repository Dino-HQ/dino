// @internal — extracted from (parent module) for max-lines compliance. Tested via (parent module).test.ts
/**
 * @dino/cli — watch command helpers (extracted from watch.ts for max-lines compliance).
 * Contains: validation, config building, iteration summary rendering, history entry builders.
 */

import path from 'node:path';
import { safePath, createTokenFactory, createAuthAdapter } from '@dino/engine';
import { shouldRenderInkView } from '../ink/InkRender';
import { getEndpoint } from '../shared/base-command';
import { CliError } from '../shared/errors';
import {
  DEFAULT_REASONING_OPTS,
  validateTools,
  validateModules,
  createExecutor,
  withAuth,
  buildTokenResolver,
  validateRbacRoles,
  validateConfigConsistency,
} from '../shared/pipeline-helpers';
import { detectUi, healthLabel, durationLabel, colorize } from '../shared/ui';
import type { CommandContext, CommonFlags } from '../shared/base-command';
import type { WatchHistoryEntry } from '../shared/history';
import type { TokenResolver } from '@dino/engine';

export interface WatchFlags extends CommonFlags {
  interval?: number | undefined;
  iterations?: number | undefined;
  once?: boolean | undefined;
  autonomy?: (string | { level: string }) | undefined;
  historyLimit?: number | undefined;
  snapshotDir?: string | undefined;
  tools?: string[] | undefined;
  modules?: string[] | undefined;
  reasoning?: boolean | undefined;
  aiKey?: string | undefined;
  timeout?: number | undefined;
  auth?: { enabled: boolean; role?: string | undefined } | undefined;
  maxConsecutiveFailures?: number | undefined;
}

export type AutonomyLevel = 'observe' | 'enforce';

const DEFAULT_HISTORY_DIR = '.dino/history';
const DEFAULT_SNAPSHOT_DIR = '.dino/snapshots';
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const VALID_AUTONOMY_LEVELS: ReadonlySet<string> = new Set(['observe', 'enforce']);

export interface IterationConfig {
  context: CommandContext;
  executor: ReturnType<typeof createExecutor>;
  tokenResolver?: TokenResolver | undefined;
  rbacRoles?: string[] | undefined;
  autonomy: AutonomyLevel;
  validatedTools?: ReturnType<typeof validateTools> | undefined;
  validatedModules?: string[] | undefined;
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
  circuitBreaker?: import('@dino/reasoning').CircuitBreaker | undefined;
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline import() required: top-level @dino/reasoning import is restricted (CLI bundle)
  reasoningCache?: import('@dino/reasoning').ReasoningCache | undefined;
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

export function resolveAutonomy(flags: WatchFlags): AutonomyLevel {
  const raw = flags.autonomy;
  let level: string;
  if (typeof raw === 'string') {
    level = raw;
  } else if (raw && typeof raw === 'object' && 'level' in raw) {
    level = raw.level;
  } else {
    level = 'observe';
  }
  if (!VALID_AUTONOMY_LEVELS.has(level)) {
    console.warn(`Unknown autonomy level "${level}", defaulting to "observe".`);
    return 'observe';
  }
  return level as AutonomyLevel;
}

export function resolveMaxIterations(flags: WatchFlags): number {
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

export function buildReasoningConfig(reasoning: boolean | undefined, aiKey: string | undefined) {
  if (reasoning) {
    if (aiKey === undefined) {
      throw new CliError(
        'Reasoning enabled but no API key provided. Set DINO_REASONING_API_KEY or pass --ai-key.',
        1,
        'Provide an Anthropic API key when using --reasoning.',
      );
    }
    return { ...DEFAULT_REASONING_OPTS, enabled: true as const, apiKey: aiKey };
  }
  return { ...DEFAULT_REASONING_OPTS, enabled: false as const, apiKey: null };
}

function buildExecutor(
  context: CommandContext,
  auth?: WatchFlags['auth'],
): { executor: ReturnType<typeof createExecutor>; tokenResolver?: TokenResolver } {
  const endpoint = getEndpoint(context);
  const base = createExecutor(endpoint);
  if (auth?.enabled && context.tenantConfig.auth) {
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
    '\u26A0\uFE0F  No auth config \u2014 running unauthenticated. RBAC matrix will only test UNAUTHENTICATED role.',
  );
  return { executor: base };
}

export function buildDegradedEntry(iteration: number, context: CommandContext): WatchHistoryEntry {
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
export function throwIfCircuitBroken(
  consecutiveFailures: number,
  cfg: IterationConfig,
  iterError: unknown,
): void {
  if (!isCircuitBroken(consecutiveFailures, cfg)) return;
  const msg = iterError instanceof Error ? iterError.message : String(iterError);
  throw new CliError(
    `[watch] ${consecutiveFailures} consecutive failures \u2014 exiting. Last error: ${msg}`,
  );
}

export interface IterationSummaryOpts {
  iteration: number;
  context: CommandContext;
  entry: WatchHistoryEntry;
  healthScore: number;
  changes: { added: number; removed: number; modified: number; breakingChanges: number };
  result: { durationMs: number; metadata: { degraded: boolean } };
  noColor?: boolean | undefined;
  quiet?: boolean | undefined;
  nextSleepSec?: number | undefined;
}

async function tryRenderInkIterationView(opts: IterationSummaryOpts): Promise<boolean> {
  const { iteration, context, entry, healthScore, changes, result, noColor, quiet, nextSleepSec } =
    opts;
  const summaryUi = detectUi({ quiet, noColor });
  if (!shouldRenderInkView(summaryUi, { quiet })) return false;
  try {
    const React = await import('react');
    const { renderViewSafe } = await import('../ink/InkRender');
    const { WatchIterationView } = await import('../views/WatchIterationView');
    const { CLI_VERSION } = await import('../version');
    return renderViewSafe(
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
  } catch (error_) {
    console.warn(
      '[dino] Ink watch view failed:',
      error_ instanceof Error ? error_.message : String(error_),
    );
    return false;
  }
}

export async function showIterationSummary(opts: IterationSummaryOpts): Promise<void> {
  if (opts.quiet) return;
  const inkShown = await tryRenderInkIterationView(opts);
  if (inkShown) return;

  const { iteration, context, entry, healthScore, changes, result, noColor, quiet } = opts;
  const summaryUi = detectUi({ quiet, noColor });
  const lines = [
    '',
    colorize(
      `\u2500\u2500 Iteration ${iteration} \u2014 ${context.environment} \u2500\u2500`,
      'dim',
      summaryUi,
    ),
    `  Health:     ${healthLabel(healthScore, summaryUi)}`,
    `  Operations: ${entry.operationCount}`,
    `  Tools:      ${entry.toolsRun} run, ${entry.toolsCompleted} completed, ${entry.toolsFailed} failed`,
    `  Breaking:   ${changes.breakingChanges > 0 ? colorize(String(changes.breakingChanges) + ' breaking', 'redBold', summaryUi) : colorize('0', 'green', summaryUi)}`,
    `  Duration:   ${colorize(durationLabel(result.durationMs), 'dim', summaryUi)}`,
  ];
  if (result.metadata.degraded) {
    const degradedMsg = '\u26A0  Degraded \u2014 all tools failed. Health score may be unreliable.';
    lines.push(`  ${colorize(degradedMsg, 'yellow', summaryUi)}`);
  }
  lines.push('');
  console.info(lines.join('\n'));
}

function validateWatchInputs(flags: WatchFlags, intervalSec: number, historyLimit: number): number {
  validateInterval(intervalSec);
  // B12 (#585): Validate iterations -- NaN causes silent exit
  resolveMaxIterations(flags); // validates; caller uses return value separately
  // B13 (#586): Validate historyLimit -- NaN causes unbounded disk growth
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
  return maxConsecutiveFailures;
}

function resolveWatchRbacRoles(context: CommandContext, quiet?: boolean): string[] | undefined {
  const rbacRoles: string[] | undefined = (context.tenantConfig as { rbac?: { roles?: string[] } })
    .rbac?.roles;
  if (!quiet && (!rbacRoles || rbacRoles.length === 0)) {
    console.info(
      'No rbac.roles in tenant config \u2014 skipping RBAC matrix. Add an rbac: section to your tenant YAML to enable.',
    );
  }
  if (rbacRoles) {
    validateRbacRoles(rbacRoles, context.tenantConfig.auth?.roles);
  }
  if (rbacRoles && context.tenantConfig.auth?.roles) {
    validateConfigConsistency(rbacRoles, context.tenantConfig.auth.roles);
  }
  return rbacRoles;
}

export function validateAndBuildConfig(
  context: CommandContext,
  flags: WatchFlags,
  intervalSec: number,
  historyLimit: number,
): IterationConfig {
  const maxConsecutiveFailures = validateWatchInputs(flags, intervalSec, historyLimit);
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
  const rbacRoles = resolveWatchRbacRoles(context, flags.quiet);

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
