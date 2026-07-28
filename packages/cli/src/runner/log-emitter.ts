/**
 * Batching live scan-log emitter (live-scan-logs Spec B).
 *
 * Buffers pipeline log lines + structured tool events and flushes them to the Spec A ingest
 * endpoint (`POST /v1/scans/:id/log-events`) on a timer cadence. Emission is best-effort and
 * NEVER fails, blocks, or delays the scan (INV-1): every surface catches internally; failures
 * disable or drop, never throw. At most one batch is in flight at a time and events flush in
 * push order (INV-2) so the cloud's max(seq)+1 allocation preserves true event order. Every
 * message is scrubbed via sanitizeEventError before it leaves the runner (INV-3).
 */

import { sanitizeEventError } from '@dino/analytics';
import type { PipelineLogger, PipelineToolEvent, Timer } from '@dino/engine';

/** Spec A wire cap: one batch carries at most 100 events. */
const MAX_EVENTS_PER_BATCH = 100;
/** Buffer hard cap — overflow drops OLDEST events and marks the gap (never silent). */
const MAX_BUFFERED_EVENTS = 1_000;
const MAX_MESSAGE_LENGTH = 2_048;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;

export type LogEmitterEvent = {
  phase: string;
  agent: string | null;
  status: string;
  level: 'info' | 'warn' | 'error';
  message: string | null;
  durationMs?: number | null;
  meta?: Record<string, unknown>;
};

export type ScanLogEmitter = {
  /** Buffer an event; never throws (INV-1). */
  push: (e: LogEmitterEvent) => void;
  /** Adapter: pipeline logger strings → 'line' events. */
  pipelineLogger: () => PipelineLogger;
  /** Adapter: engine tool events → wire events. */
  onToolEvent: (e: PipelineToolEvent) => void;
  /** Final best-effort flush (single attempt), then permanently inert. */
  stop: () => Promise<void>;
};

export type CreateScanLogEmitterOptions = {
  cloudEndpoint: string;
  runnerToken: string;
  /** Pool identity: sent as x-dino-scan-capability on every POST. */
  capabilityToken?: string | undefined;
  scanId: string;
  httpClient: (url: string, init?: RequestInit) => Promise<Response>;
  timer: Timer;
  /** Injected for determinism; default crypto.randomUUID. */
  batchIdGen?: (() => string) | undefined;
  flushIntervalMs?: number | undefined;
};

type PendingBatch = { events: LogEmitterEvent[]; batchId: string; retried: boolean };

type EmitterState = {
  opts: CreateScanLogEmitterOptions;
  url: string;
  batchIdGen: () => string;
  flushIntervalMs: number;
  buffer: LogEmitterEvent[];
  /** The batch currently being sent/retried (kept across ONE failed tick, then dropped). */
  pending: PendingBatch | null;
  disabled: boolean;
  inFlight: boolean;
  droppedSinceLastBatch: number;
  tickHandle: ReturnType<Timer['setTimeout']> | null;
  stopped: boolean;
};

function ingestUrl(cloudEndpoint: string, scanId: string): string {
  const base = cloudEndpoint.replace(/\/$/, '');
  return `${base}/v1/scans/${encodeURIComponent(scanId)}/log-events`;
}

function scrub(message: string | null): string | null {
  if (message === null) return null;
  return sanitizeEventError(message).slice(0, MAX_MESSAGE_LENGTH);
}

function logEmitterEvent(name: string, data: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: name, ...data }));
}

function disable(state: EmitterState, reason: string, detail: Record<string, unknown>): void {
  if (state.disabled) return;
  state.disabled = true;
  state.buffer = [];
  state.pending = null;
  logEmitterEvent('log_emitter_disabled', { scan_id: state.opts.scanId, reason, ...detail });
}

function takeBatch(state: EmitterState): PendingBatch | null {
  if (state.pending) return state.pending;
  if (state.buffer.length === 0) return null;
  const events = state.buffer.slice(0, MAX_EVENTS_PER_BATCH);
  state.buffer = state.buffer.slice(events.length);
  const first = events[0];
  if (state.droppedSinceLastBatch > 0 && first) {
    // Honest gap marker (INV: never silent loss) — stamp the drop count on the batch head.
    first.meta = { ...first.meta, droppedBeforeThis: state.droppedSinceLastBatch };
    state.droppedSinceLastBatch = 0;
  }
  state.pending = { events, batchId: state.batchIdGen(), retried: false };
  return state.pending;
}

function emitterHeaders(state: EmitterState): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${state.opts.runnerToken}`,
  };
  if (state.opts.capabilityToken !== undefined) {
    headers['x-dino-scan-capability'] = state.opts.capabilityToken;
  }
  return headers;
}

async function postBatch(state: EmitterState, batch: PendingBatch): Promise<void> {
  const res = await state.opts.httpClient(state.url, {
    method: 'POST',
    headers: emitterHeaders(state),
    body: JSON.stringify({ events: batch.events, batchId: batch.batchId }),
  });
  if (res.status === 401 || res.status === 404 || res.status === 409) {
    disable(state, 'rejected', { status: res.status });
    return;
  }
  if (res.status === 202) {
    // Cap reached — cloud acknowledges without writing; stop sending (INV-5 of Spec A).
    disable(state, 'truncated', { status: 202 });
    return;
  }
  if (!res.ok) throw new Error(`ingest HTTP ${String(res.status)}`);
  state.pending = null;
}

async function flushOnce(state: EmitterState): Promise<void> {
  if (state.disabled || state.inFlight) return;
  const batch = takeBatch(state);
  if (!batch) return;
  state.inFlight = true;
  try {
    await postBatch(state, batch);
  } catch (e) {
    if (batch.retried) {
      state.pending = null;
      logEmitterEvent('log_emitter_batch_dropped', {
        scan_id: state.opts.scanId,
        count: batch.events.length,
        detail: e instanceof Error ? e.message : String(e),
      });
    } else {
      batch.retried = true; // kept for ONE more tick
    }
  } finally {
    state.inFlight = false;
  }
}

function scheduleTick(state: EmitterState): void {
  if (state.stopped || state.disabled) return;
  state.tickHandle = state.opts.timer.setTimeout(() => {
    void flushOnce(state).finally(() => {
      scheduleTick(state);
    });
  }, state.flushIntervalMs);
}

function pushEvent(state: EmitterState, e: LogEmitterEvent): void {
  if (state.disabled || state.stopped) return;
  if (state.buffer.length >= MAX_BUFFERED_EVENTS) {
    state.buffer.shift();
    state.droppedSinceLastBatch += 1;
  }
  state.buffer.push({ ...e, message: scrub(e.message) });
}

/** Pure mapping: engine tool event → wire event. */
function toolEventToWire(e: PipelineToolEvent): LogEmitterEvent {
  if (e.type === 'tool.started') {
    return {
      phase: 'agent',
      agent: e.tool,
      status: 'tool.started',
      level: 'info',
      message: `Running ${e.tool} (${String(e.index + 1)}/${String(e.total)})`,
    };
  }
  const failed = e.record.status !== 'COMPLETED';
  return {
    phase: 'agent',
    agent: e.record.toolName,
    status: 'tool.finished',
    level: failed ? 'error' : 'info',
    message: e.record.errorMessage ?? `${e.record.toolName} ${e.record.status.toLowerCase()}`,
    durationMs: e.record.durationMs,
    meta: {
      status: e.record.status,
      ...(e.record.summary ? { summary: e.record.summary } : {}),
    },
  };
}

function lineLogger(push: (e: LogEmitterEvent) => void): PipelineLogger {
  const line = (level: 'info' | 'warn' | 'error') => (msg: string) =>
    push({ phase: 'system', agent: null, status: 'line', level, message: msg });
  return { info: line('info'), warn: line('warn'), error: line('error') };
}

export function createScanLogEmitter(opts: CreateScanLogEmitterOptions): ScanLogEmitter {
  const state: EmitterState = {
    opts,
    url: ingestUrl(opts.cloudEndpoint, opts.scanId),
    batchIdGen: opts.batchIdGen ?? ((): string => crypto.randomUUID()), // determinism:allowed — injected seam default
    flushIntervalMs: opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    buffer: [],
    pending: null,
    disabled: false,
    inFlight: false,
    droppedSinceLastBatch: 0,
    tickHandle: null,
    stopped: false,
  };
  scheduleTick(state);

  const push = (e: LogEmitterEvent): void => {
    pushEvent(state, e);
  };
  return {
    push,
    pipelineLogger: () => lineLogger(push),
    onToolEvent: (e) => {
      push(toolEventToWire(e));
    },
    stop: async (): Promise<void> => {
      if (state.stopped) return;
      state.stopped = true;
      if (state.tickHandle !== null) state.opts.timer.clearTimeout(state.tickHandle);
      try {
        await flushOnce(state);
      } catch (e) {
        // final flush is best-effort — never throws into the scan path (INV-1); observable signal only
        logEmitterEvent('log_emitter_final_flush_failed', {
          scan_id: state.opts.scanId,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}
