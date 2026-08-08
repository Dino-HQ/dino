/**
 * Cloud assignment polling loop (Issue #1150).
 */

import {
  asScanId,
  asTenantId,
  type RunnerJob,
  type RunnerResult,
  type SentinelScanCommand,
} from '@dino/core';
import { SystemTimer } from '@dino/engine';
import type { ScanReporter } from './inngest-reporter';
import type { RunnerState } from './state-store';
import type { Timer } from '@dino/engine';

export interface PollLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface PollLoopConfig {
  state: RunnerState;
  httpClient: (url: string, init?: RequestInit) => Promise<Response>;
  reporter: ScanReporter;
  executeScan: (assignment: RunnerJob) => Promise<RunnerResult>;
  logger: PollLogger;
  signal: AbortSignal;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  timer?: Timer;
}

/**
 * Assemble a PollLoopConfig (exactOptionalPropertyTypes-safe: undefined poll/backoff overrides are
 * omitted, not set). Shared by `dino runner start`'s poll loop and the #70 wake-server one-shot.
 */
export function buildPollLoopConfig(args: {
  state: RunnerState;
  httpClient: (url: string, init?: RequestInit) => Promise<Response>;
  reporter: ScanReporter;
  executeScan: (a: RunnerJob) => Promise<RunnerResult>;
  logger: PollLogger;
  signal: AbortSignal;
  timer: Timer;
  pollIntervalMs: number | undefined;
  maxBackoffMs: number | undefined;
}): PollLoopConfig {
  const { state, httpClient, reporter, executeScan, logger, signal, timer } = args;
  return {
    state,
    httpClient,
    reporter,
    executeScan,
    logger,
    signal,
    timer,
    ...(args.pollIntervalMs == null ? {} : { pollIntervalMs: args.pollIntervalMs }),
    ...(args.maxBackoffMs == null ? {} : { maxBackoffMs: args.maxBackoffMs }),
  };
}

export class RunnerUnauthorizedError extends Error {
  constructor() {
    super('RUNNER_UNAUTHORIZED');
    this.name = 'RunnerUnauthorizedError';
  }
}

function assignmentsUrl(state: RunnerState): string {
  const base = state.cloudEndpoint.replace(/\/$/, '');
  return `${base}/v1/runners/${encodeURIComponent(state.runnerId)}/assignments`;
}

async function waitMs(timer: Timer, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const handle = timer.setTimeout(() => {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      if (settled) return;
      timer.clearTimeout(handle);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isSentinelScanCommand(value: unknown): value is SentinelScanCommand {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  const scope = o.scope;
  const context = o.context;
  if (typeof o.tenantId !== 'string' || typeof o.apiId !== 'string') return false;
  if (scope === null || typeof scope !== 'object') return false;
  const s = scope as Record<string, unknown>;
  if (!Array.isArray(s.agents) || typeof s.depth !== 'string') return false;
  if (context === null || typeof context !== 'object') return false;
  const ctx = context as Record<string, unknown>;
  return (
    ctx.trigger === 'sentinel' && Array.isArray(ctx.triggerClasses) && Array.isArray(ctx.signalIds)
  );
}

function parseOptionalCommand(commandRaw: unknown): SentinelScanCommand | undefined {
  if (commandRaw === undefined) {
    return undefined;
  }
  if (isSentinelScanCommand(commandRaw)) {
    return commandRaw;
  }
  return undefined;
}

function parseOptionalNonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function parseOptionalProtocol(value: unknown): 'rest' | 'graphql' | undefined {
  if (value === 'rest' || value === 'graphql') return value;
  return undefined;
}

function parseOptionalSpecFormat(value: unknown): 'json' | 'yaml' | undefined {
  if (value === 'json' || value === 'yaml') return value;
  return undefined;
}

function parseOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const strings: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') return undefined;
    strings.push(v);
  }
  return strings;
}

function assembleRunnerJob(
  o: Record<string, unknown>,
  ids: { scanId: string; tenantId: string; targetUrl: string },
): RunnerJob {
  const command = parseOptionalCommand(o.command);
  const authProfileId = parseOptionalNonBlankString(o.authProfileId);
  const capabilityToken = parseOptionalNonBlankString(o.capabilityToken);
  const protocol = parseOptionalProtocol(o.protocol);
  const specUrl = parseOptionalNonBlankString(o.specUrl);
  const specBody = parseOptionalNonBlankString(o.specBody);
  const specFormat = parseOptionalSpecFormat(o.specFormat);
  const agentSet = parseOptionalStringArray(o.agentSet);
  return {
    scanId: asScanId(ids.scanId),
    tenantId: asTenantId(ids.tenantId),
    targetUrl: ids.targetUrl,
    ...(command === undefined ? {} : { command }),
    ...(authProfileId === undefined ? {} : { authProfileId }),
    ...(capabilityToken === undefined ? {} : { capabilityToken }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(specUrl === undefined ? {} : { specUrl }),
    ...(specBody === undefined ? {} : { specBody }),
    ...(specFormat === undefined ? {} : { specFormat }),
    ...(agentSet === undefined ? {} : { agentSet }),
  };
}

/** Parse assignment JSON from GET /v1/runners/:id/assignments (#1388). */
export function parseAssignment(json: unknown): RunnerJob | null {
  if (json === null || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const scanId = o.scanId;
  const tenantId = o.tenantId;
  const targetUrl = o.targetUrl;
  if (typeof scanId === 'string' && typeof tenantId === 'string' && typeof targetUrl === 'string') {
    return assembleRunnerJob(o, { scanId, tenantId, targetUrl });
  }
  return null;
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function formatPollThrown(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return 'unexpected_poll_error';
}

/** Shared optional extras every terminal report carries (Spec B): rotated RT + pool capability. */
function terminalExtras(result: RunnerResult, assignment: RunnerJob): Record<string, string> {
  const extras: Record<string, string> = {};
  if (result.rotatedRefreshToken !== undefined)
    extras.rotatedRefreshToken = result.rotatedRefreshToken;
  // Pool identity: the results POST needs the scan-bound capability or the cloud 401s it (Spec B).
  if (assignment.capabilityToken !== undefined) extras.capabilityToken = assignment.capabilityToken;
  return extras;
}

async function handleAssignment(config: PollLoopConfig, assignment: RunnerJob): Promise<void> {
  const result = await config.executeScan(assignment);
  const extras = terminalExtras(result, assignment);
  if (result.status === 'completed') {
    await config.reporter.reportCompleted(result.scanId, result.dcg, {
      ...(result.attestation === undefined ? {} : { attestation: result.attestation }),
      ...(result.result === undefined ? {} : { pipelineResult: result.result }),
      ...extras,
    });
  } else if (result.status === 'cancelled') {
    // Terminal cancel (Spec B INV-4) — a distinct state, never conflated with 'failed'.
    await config.reporter.reportCancelled(result.scanId, result.toolsCompletedCount, extras);
  } else {
    await config.reporter.reportFailed(result.scanId, result.error ?? 'pipeline_failed', {
      ...(result.failureType === undefined ? {} : { failureType: result.failureType }),
      ...extras,
    });
  }
}

/** Options for handlePollResponse. */
interface HandlePollResponseOptions {
  config: PollLoopConfig;
  res: Response;
  timer: Timer;
  pollIntervalMs: number;
  pollStart: number;
}

async function handlePollResponse(
  opts: HandlePollResponseOptions,
): Promise<'continue' | 'backoff'> {
  const { config, res, timer, pollIntervalMs, pollStart } = opts;
  if (res.status === 401) {
    config.logger.error('runner_poll_unauthorized', { status: 401 });
    throw new RunnerUnauthorizedError();
  }

  if (res.ok && res.status === 200) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      config.logger.error('runner_poll_invalid_json', { status: 200 });
      await waitMs(timer, pollIntervalMs, config.signal);
      return 'continue';
    }

    const assignment = parseAssignment(body);
    if (!assignment) {
      config.logger.error('runner_poll_bad_assignment_shape', {});
      await waitMs(timer, pollIntervalMs, config.signal);
      return 'continue';
    }

    const durationMs = Date.now() - pollStart; // determinism:allowed
    config.logger.info('poll', { status: 200, scanId: assignment.scanId, duration_ms: durationMs });
    await handleAssignment(config, assignment);
    return 'continue';
  }

  if (res.status === 204) {
    const durationMs = Date.now() - pollStart; // determinism:allowed
    config.logger.info('poll', { status: 204, duration_ms: durationMs });
    await waitMs(timer, pollIntervalMs, config.signal);
    return 'continue';
  }

  config.logger.error('runner_poll_unexpected_status', { status: res.status });
  return 'backoff';
}

/**
 * #70: run a SINGLE assignment poll → claim → execute cycle (no loop, no backoff, no inter-poll
 * sleep). The wake-server invokes this when the cloud wakes a scaled-to-zero pool runner: it claims
 * the one scan the wake targets and runs it to completion, with the caller holding the HTTP response
 * open so the autoscaler keeps the instance "serving" mid-scan. A 204 (no work — e.g. a forged/raced
 * wake) is a no-op. The background `startPollLoop` still runs as the always-on fallback (INV-2).
 */
export async function pollOnce(config: PollLoopConfig): Promise<void> {
  const res = await config.httpClient(assignmentsUrl(config.state), {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.state.token}` },
  });
  if (res.status === 401) {
    config.logger.error('runner_poll_unauthorized', { status: 401 });
    throw new RunnerUnauthorizedError();
  }
  if (res.ok && res.status === 200) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      config.logger.error('runner_poll_invalid_json', { status: 200 });
      return;
    }
    const assignment = parseAssignment(body);
    if (!assignment) {
      config.logger.error('runner_poll_bad_assignment_shape', {});
      return;
    }
    config.logger.info('wake_poll', { status: 200, scanId: assignment.scanId });
    await handleAssignment(config, assignment);
  }
}

async function doPoll(
  config: PollLoopConfig,
  timer: Timer,
  pollIntervalMs: number,
): Promise<'continue' | 'backoff'> {
  const pollStart = Date.now(); // determinism:allowed - logging only
  const res = await config.httpClient(assignmentsUrl(config.state), {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.state.token}` },
  });
  return handlePollResponse({ config, res, timer, pollIntervalMs, pollStart });
}

async function sleepWithAbort(timer: Timer, ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await waitMs(timer, ms, signal);
    return true;
  } catch (e) {
    if (isAbortError(e)) return false;
    throw e;
  }
}

function handlePollError(e: unknown, logger: PollLogger): 'break' | 'backoff' {
  if (e instanceof RunnerUnauthorizedError) throw e;
  if (isAbortError(e)) return 'break';
  logger.error('poll_error', {
    message: formatPollThrown(e),
  });
  return 'backoff';
}

export async function startPollLoop(config: PollLoopConfig): Promise<void> {
  const pollIntervalMs = config.pollIntervalMs ?? 5_000;
  const maxBackoffMs = config.maxBackoffMs ?? 60_000;
  const timer = config.timer ?? SystemTimer;
  let backoffMs = 1000;

  while (!config.signal.aborted) {
    let needsBackoff = true;
    try {
      const action = await doPoll(config, timer, pollIntervalMs);
      if (action === 'continue') {
        backoffMs = 1000;
        needsBackoff = false;
      }
    } catch (e) {
      if (handlePollError(e, config.logger) === 'break') break;
    }

    if (config.signal.aborted) break;
    if (!needsBackoff) continue;

    const wait = Math.min(maxBackoffMs, backoffMs);
    backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
    if (!(await sleepWithAbort(timer, wait, config.signal))) break;
  }
}
