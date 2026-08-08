/**
 * #70: minimal HTTP server for pool runners. Two purposes:
 *  1. Satisfies the Cloud Run container contract — a pool runner MUST listen on `0.0.0.0:$PORT` to be
 *     deployable at all (this is why #76's pool deploy was never proven healthy).
 *  2. Is the wake target: `POST /wake` spins the (possibly scaled-to-zero) instance up and runs ONE
 *     poll→claim→execute cycle, holding the response open until the scan completes so the autoscaler
 *     does not reap the instance mid-scan.
 *
 * Auth (INV-4): `/wake` requires `Authorization: Bearer <wakeSecret>`. A missing/empty secret or a bad
 * bearer is rejected with 401 and runs no scan — the endpoint is on a public `*.run.app` URL. The wake
 * grants NO authority beyond triggering a poll; tenant/scan authority still rides the #68 capability
 * token minted at `/assignments` (INV-5). The background poll loop remains the always-on fallback.
 */

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * #70 Maciver M4: token-bucket limiter for the PUBLIC `/wake` endpoint. Bounds authed-flood abuse (a
 * leaked secret can't drive unbounded wakes against the single instance). Injectable clock keeps it
 * deterministic for tests. The network-layer ingress restriction (only the worker egress reaches the
 * URL) is the complementary fix tracked in #78.
 */
export interface WakeLimiter {
  /** True if a token was available (request allowed); false → 429. */
  tryAcquire(): boolean;
}

export function createWakeLimiter(
  nowMs: () => number,
  capacity = 5,
  refillPerMinute = 30,
): WakeLimiter {
  let tokens = capacity;
  let last = nowMs();
  return {
    tryAcquire(): boolean {
      const now = nowMs();
      tokens = Math.min(capacity, tokens + ((now - last) / 60_000) * refillPerMinute);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}

/** Timing-safe `Bearer <secret>` check (#70 Maciver LOW). Empty secret → false (fail-closed, INV-4). */
function bearerMatches(authHeader: string | undefined, secret: string): boolean {
  if (secret.length === 0) return false; // unset secret → fail-closed (config guard, not a compare)
  const expected = `Bearer ${secret}`;
  // Length is not secret (it's `Bearer ` + a known-length token), so an early length check is safe and
  // required (timingSafeEqual throws on unequal-length buffers).
  if (authHeader?.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
}

export interface WakeServerDeps {
  /** Shared bearer the cloud sends (DINO_RUNNER_WAKE_SECRET). Empty string → wake disabled (401 all). */
  wakeSecret: string;
  /** Runs one poll→claim→execute cycle (poll-loop `pollOnce`); awaited so the response is held open. */
  onWake: () => Promise<void>;
  /** Optional rate limiter for `/wake` (#70 M4). Omitted → unlimited (used by the pure-router tests). */
  limiter?: WakeLimiter;
  logger?: {
    info(m: string, d?: Record<string, unknown>): void;
    error(m: string, d?: Record<string, unknown>): void;
  };
}

export interface WakeRouteResult {
  status: number;
  body: string;
}

/**
 * Pure request router — no socket, directly unit-testable (Determinism Contract). `/healthz` → 200
 * (Cloud Run startup probe); `/wake` → 401 (bad/missing bearer), 202 (cycle ran), or 500 (handler
 * threw — the poll loop is the fallback). Any other route → 404.
 */
export async function handleWakeRoute(
  deps: WakeServerDeps,
  method: string,
  path: string,
  authHeader: string | undefined,
): Promise<WakeRouteResult> {
  if (method === 'GET' && path === '/healthz') {
    return { status: 200, body: 'ok' };
  }
  if (method === 'POST' && path === '/wake') {
    // INV-4: fail-closed. An unset secret (empty) rejects ALL callers — never run a scan on a forged
    // or misconfigured wake. Timing-safe compare (#70 Maciver LOW); the wake grants no authority beyond
    // a poll (INV-5).
    if (!bearerMatches(authHeader, deps.wakeSecret)) {
      deps.logger?.error('wake_rejected_unauthorized', {});
      return { status: 401, body: 'unauthorized' };
    }
    // #70 M4: rate-limit even authed wakes on the public endpoint (a leaked secret can't flood the
    // single instance). 429 over the bucket; the cloud's wake is best-effort, so a 429 just falls back
    // to the poll/watchdog net (INV-2).
    if (deps.limiter !== undefined && !deps.limiter.tryAcquire()) {
      deps.logger?.error('wake_rate_limited', {});
      return { status: 429, body: 'rate_limited' };
    }
    try {
      await deps.onWake(); // held open until the scan completes (keeps the instance serving)
      return { status: 202, body: 'accepted' };
    } catch (err) {
      deps.logger?.error('wake_cycle_failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
      return { status: 500, body: 'wake_failed' }; // poll-loop fallback still claims (fault #3)
    }
  }
  return { status: 404, body: 'not_found' };
}

/**
 * #70: start the wake server ONLY for pool runners (`DINO_RUNNER_MODE === 'pool'`), reading the secret
 * + port from env (overridable for tests). Non-pool runners get no server (undefined). The wake runs
 * one poll→execute cycle (`onWake`); the background poll loop stays the always-on fallback (INV-2).
 */
export function maybeStartWakeServer(opts: {
  onWake: () => Promise<void>;
  logger: WakeServerDeps['logger'];
  mode: string | undefined;
  wakeSecret: string | undefined;
  port: number | undefined;
}): Server | undefined {
  if ((opts.mode ?? process.env.DINO_RUNNER_MODE) !== 'pool') return undefined;
  const wakeSecret = opts.wakeSecret ?? process.env.DINO_RUNNER_WAKE_SECRET ?? '';
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  // Default token bucket for the public endpoint (#70 M4): 5 burst, refill 30/min. Date.now is fine
  // here — rate-limiting is operational, not business logic (the runner CLI, not the deterministic core).
  const limiter = createWakeLimiter(() => Date.now()); // determinism:allowed - operational rate limit
  return startWakeServer(
    { wakeSecret, onWake: opts.onWake, limiter, ...(opts.logger ? { logger: opts.logger } : {}) },
    port,
  );
}

/** Bind the wake server on `0.0.0.0:port` (Cloud Run `$PORT`). Listener-first; heavy setup deferred. */
export function startWakeServer(deps: WakeServerDeps, port: number): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    void handleWakeRoute(deps, req.method ?? '', path, req.headers.authorization).then((result) => {
      res.writeHead(result.status, { 'Content-Type': 'text/plain' });
      res.end(result.body);
    });
  });
  server.listen(port, '0.0.0.0', () => {
    deps.logger?.info('wake_server_listening', { port });
  });
  return server;
}
