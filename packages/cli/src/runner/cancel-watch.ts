/**
 * Cancel-flag watch (live-scan-logs Spec B).
 *
 * Polls `GET /v1/scans/:id/control` while a scan executes; when the cloud reports
 * `cancelRequested: true`, fires `onCancel` exactly once and stops. Failure policy mirrors the
 * emitter's never-break-the-scan contract (Spec B INV-1): transient errors keep polling (a cloud
 * blip must not kill cancellation), but 401/404 stop the watch permanently — an old cloud without
 * the endpoint or a rejected identity means the scan simply runs to completion, as today.
 */

import type { Timer } from '@dino/engine';

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export type StartCancelWatchOptions = {
  cloudEndpoint: string;
  runnerToken: string;
  /** Pool identity: sent as x-dino-scan-capability on every GET. */
  capabilityToken?: string | undefined;
  scanId: string;
  httpClient: (url: string, init?: RequestInit) => Promise<Response>;
  timer: Timer;
  /** Called AT MOST once. */
  onCancel: () => void;
  pollIntervalMs?: number | undefined;
};

type WatchState = {
  opts: StartCancelWatchOptions;
  url: string;
  stopped: boolean;
  cancelled: boolean;
  failureLogged: boolean;
  handle: ReturnType<Timer['setTimeout']> | null;
};

type PollOutcome = 'cancel' | 'stop' | 'continue';

function controlUrl(cloudEndpoint: string, scanId: string): string {
  const base = cloudEndpoint.replace(/\/$/, '');
  return `${base}/v1/scans/${encodeURIComponent(scanId)}/control`;
}

function logWatchEvent(name: string, data: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: name, ...data }));
}

function logTransientOnce(state: WatchState, detail: Record<string, unknown>): void {
  if (state.failureLogged) return;
  state.failureLogged = true;
  logWatchEvent('cancel_watch_poll_failed', { scan_id: state.opts.scanId, ...detail });
}

async function classifyResponse(state: WatchState, res: Response): Promise<PollOutcome> {
  if (res.status === 401 || res.status === 404) {
    // Old cloud (no control endpoint) or rejected identity — the scan proceeds uncancellable.
    logWatchEvent('cancel_watch_stopped', { scan_id: state.opts.scanId, status: res.status });
    return 'stop';
  }
  if (!res.ok) {
    logTransientOnce(state, { status: res.status });
    return 'continue';
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return 'continue';
  }
  const flag =
    body !== null && typeof body === 'object' && 'cancelRequested' in body
      ? body.cancelRequested === true
      : false;
  return flag ? 'cancel' : 'continue';
}

async function pollOnce(state: WatchState): Promise<PollOutcome> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.opts.runnerToken}`,
  };
  if (state.opts.capabilityToken !== undefined) {
    headers['x-dino-scan-capability'] = state.opts.capabilityToken;
  }
  let res: Response;
  try {
    res = await state.opts.httpClient(state.url, { method: 'GET', headers });
  } catch (e) {
    // Transient network failure — log once, keep polling (INV-1: never break cancellation
    // over a blip, never break the scan over cancellation).
    logTransientOnce(state, { detail: e instanceof Error ? e.message : String(e) });
    return 'continue';
  }
  return classifyResponse(state, res);
}

function stopWatch(state: WatchState): void {
  if (state.stopped) return;
  state.stopped = true;
  if (state.handle !== null) state.opts.timer.clearTimeout(state.handle);
}

function schedule(state: WatchState): void {
  if (state.stopped) return;
  state.handle = state.opts.timer.setTimeout(() => {
    void pollOnce(state).then((outcome) => {
      if (outcome === 'stop') {
        stopWatch(state);
        return;
      }
      if (outcome === 'cancel' && !state.cancelled) {
        state.cancelled = true;
        stopWatch(state);
        state.opts.onCancel();
        return;
      }
      schedule(state);
    });
  }, state.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
}

export function startCancelWatch(opts: StartCancelWatchOptions): { stop: () => void } {
  const state: WatchState = {
    opts,
    url: controlUrl(opts.cloudEndpoint, opts.scanId),
    stopped: false,
    cancelled: false,
    failureLogged: false,
    handle: null,
  };
  schedule(state);
  return {
    stop: () => {
      stopWatch(state);
    },
  };
}
