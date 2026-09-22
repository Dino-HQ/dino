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
import { EXIT_CODE, outcomeKindFromIterationError } from '../shared/outcome';
import {
  validateTools,
  validateModules,
  createExecutor,
  withAuth,
  buildTokenResolver,
  validateRbacRoles,
  validateConfigConsistency,
} from '../shared/pipeline-helpers';
import { detectUi, healthVerdictLabel, durationLabel, colorize, printNotice } from '../shared/ui';
import type { CommandContext, CommonFlags } from '../shared/base-command';
import type { WatchHistoryEntry } from '../shared/history';
import type { UiOptions } from '../shared/ui';
import type { DinoResult } from '@dino/core';
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
  snapshotDir: string;
  timeoutMs: number;
  historyDir: string;
  historyLimit: number;
  maxConsecutiveFailures: number;
  /** Seconds until next iteration (for Ink countdown when another loop is scheduled). */
  intervalSec: number;
}

function validateInterval(interval: number): void {
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new CliError(
      `Invalid interval: ${interval}. Must be a positive number of seconds.`,
      2,
      'Use a positive number of seconds, e.g. --interval 300.',
      undefined,
      'usage',
    );
  }
}

export function resolveAutonomy(flags: WatchFlags, ui?: UiOptions): AutonomyLevel {
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
    const noticeUi = ui ?? detectUi({ quiet: flags.quiet, noColor: flags.noColor });
    printNotice(`Unknown autonomy level "${level}", defaulting to "observe".`, noticeUi);
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
        2,
        'Use a positive integer, e.g. --iterations 5.',
        undefined,
        'usage',
      );
    }
    return n;
  }
  return Infinity;
}

function buildExecutor(
  context: CommandContext,
  auth: WatchFlags['auth'] | undefined,
  ui: UiOptions,
): { executor: ReturnType<typeof createExecutor>; tokenResolver?: TokenResolver } {
  const endpoint = getEndpoint(context);
  const base = createExecutor(endpoint, undefined, {
    allowPrivateTarget: context.allowPrivateTarget === true,
  });
  if (auth?.enabled && context.tenantConfig.auth) {
    const tokenFactory = createTokenFactory({
      endpoint,
      tenantId: context.tenantId,
      allowPrivateTarget: context.allowPrivateTarget,
      adapter: createAuthAdapter(context.tenantConfig.auth, {
        allowPrivateTarget: context.allowPrivateTarget,
      }),
      refreshBufferMs: (context.tenantConfig.auth?.tokenRefresh?.expiryBuffer ?? 60) * 1000,
    });
    const executor = withAuth(base, tokenFactory, auth.role ?? 'USER');
    const tokenResolver = buildTokenResolver(tokenFactory);
    return { executor, tokenResolver };
  }
  printNotice('Running unauthenticated. RBAC matrix will only test the UNAUTHENTICATED role.', ui);
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
    operationCount: null,
    toolsRun: 0,
    toolsCompleted: 0,
    toolsFailed: 0,
    degraded: true,
    healthScore: null,
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
  const kind = outcomeKindFromIterationError(iterError);
  const exitCode = EXIT_CODE.get(kind) ?? 70;
  throw new CliError(
    `[watch] ${consecutiveFailures} consecutive failures: exiting. Last error: ${msg}`,
    exitCode,
    undefined,
    iterError,
    kind,
    kind === 'transient' ? 'transient' : 'permanent',
  );
}

export interface IterationSummaryOpts {
  iteration: number;
  context: CommandContext;
  entry: WatchHistoryEntry;
  /** `verdict.health`, copied: both presentation paths print this verdict, neither re-derives it. */
  health: DinoResult['verdict']['health'];
  changes: { added: number; removed: number; modified: number; breakingChanges: number };
  /** Copied from the canonical result (`verification.durationMs`, `verdict.degraded`). */
  result: { durationMs: number; degraded: boolean };
  noColor?: boolean | undefined;
  quiet?: boolean | undefined;
  nextSleepSec?: number | undefined;
}

async function tryRenderInkIterationView(opts: IterationSummaryOpts): Promise<boolean> {
  const { iteration, context, entry, health, changes, result, noColor, quiet, nextSleepSec } = opts;
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
        healthScore: health.score,
        healthVerdict: health.verdict,
        healthLevel: health.level,
        operationCount: entry.operationCount,
        toolsRun: entry.toolsRun,
        toolsCompleted: entry.toolsCompleted,
        toolsFailed: entry.toolsFailed,
        breakingChanges: changes.breakingChanges,
        durationMs: result.durationMs,
        degraded: result.degraded,
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

  const { iteration, context, entry, health, changes, result, noColor, quiet } = opts;
  const summaryUi = detectUi({ quiet, noColor });
  const lines = [
    '',
    colorize(
      `\u2500\u2500 Iteration ${iteration}: ${context.environment} \u2500\u2500`,
      'dim',
      summaryUi,
    ),
    `  Health:     ${healthVerdictLabel(health, summaryUi)}`,
    `  Operations: ${entry.operationCount ?? '?'}`,
    `  Tools:      ${entry.toolsRun} run, ${entry.toolsCompleted} completed, ${entry.toolsFailed} failed`,
    `  Breaking:   ${changes.breakingChanges > 0 ? colorize(String(changes.breakingChanges) + ' breaking', 'redBold', summaryUi) : colorize('0', 'green', summaryUi)}`,
    `  Duration:   ${colorize(durationLabel(result.durationMs), 'dim', summaryUi)}`,
  ];
  if (result.degraded) {
    const degradedMsg = 'Degraded: all tools failed. Health score may be unreliable.';
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
      2,
      'Use a positive integer, e.g. --history-limit 50.',
      undefined,
      'usage',
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
      2,
      'Use a positive integer, e.g. --max-consecutive-failures 5.',
      undefined,
      'usage',
    );
  }
  return maxConsecutiveFailures;
}

function resolveWatchRbacRoles(context: CommandContext, ui: UiOptions): string[] | undefined {
  const rbacRoles: string[] | undefined = (context.tenantConfig as { rbac?: { roles?: string[] } })
    .rbac?.roles;
  if (!rbacRoles || rbacRoles.length === 0) {
    printNotice(
      'No rbac.roles in tenant config: skipping RBAC matrix. Add an rbac: section to your tenant YAML to enable.',
      ui,
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
  const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  const autonomy = resolveAutonomy(flags, ui);
  const validatedTools = flags.tools ? validateTools(flags.tools) : undefined;
  const validatedModules = flags.modules
    ? validateModules(flags.modules, context.tenantId)
    : undefined;
  const { executor, tokenResolver } = buildExecutor(context, flags.auth, ui);
  const rbacRoles = resolveWatchRbacRoles(context, ui);

  return {
    context,
    executor,
    tokenResolver,
    rbacRoles,
    autonomy,
    validatedTools,
    validatedModules,
    snapshotDir: flags.snapshotDir ? safePath(flags.snapshotDir) : DEFAULT_SNAPSHOT_DIR,
    timeoutMs: flags.timeout ?? 300_000,
    historyDir: path.join(process.cwd(), DEFAULT_HISTORY_DIR),
    historyLimit,
    maxConsecutiveFailures,
    intervalSec,
  };
}
