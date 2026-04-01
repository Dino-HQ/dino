/**
 * @dino/reasoning — Circuit Breaker for LLM Providers (Issue #355)
 *
 * Prevents cascading failures when an LLM provider is down.
 * State machine: CLOSED → OPEN → HALF_OPEN → CLOSED (on success) or OPEN (on failure).
 *
 * Usage:
 *   const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 });
 *   const result = await breaker.execute(() => provider.complete(request));
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. Default: 3 */
  failureThreshold?: number;
  /** Cooldown in ms before probing. Default: 30_000 (30s) */
  resetTimeoutMs?: number;
  /** Optional callback on state change */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
  /** Injectable clock for deterministic testing. Default: wall-clock */
  clock?: { now(): number };
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private probeInFlight = false;
  private readonly clock: { now(): number };

  constructor(private readonly opts: CircuitBreakerOptions = {}) {
    this.clock = opts.clock ?? { now: () => Date.now() }; // determinism:seam
  }

  get currentState(): CircuitState {
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const threshold = this.opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    const resetMs = this.opts.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;

    if (this.state === 'OPEN') {
      if (this.clock.now() - this.lastFailureAt >= resetMs) {
        if (this.probeInFlight) {
          throw new CircuitOpenError(0);
        }
        this.probeInFlight = true;
        this.transition('HALF_OPEN');
      } else {
        throw new CircuitOpenError(resetMs - (this.clock.now() - this.lastFailureAt));
      }
    } else if (this.state === 'HALF_OPEN' && this.probeInFlight) {
      throw new CircuitOpenError(0);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(threshold);
      throw err;
    } finally {
      if (this.state !== 'HALF_OPEN') {
        this.probeInFlight = false;
      }
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureAt = 0;
    this.probeInFlight = false;
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.probeInFlight = false;
      this.transition('CLOSED');
    }
    this.consecutiveFailures = 0;
  }

  private onFailure(threshold: number): void {
    this.consecutiveFailures++;
    this.lastFailureAt = this.clock.now();
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= threshold) {
      this.probeInFlight = false;
      this.transition('OPEN');
    }
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    this.state = to;
    if (from !== to) {
      this.opts.onStateChange?.(from, to);
    }
  }
}

export class CircuitOpenError extends Error {
  constructor(public readonly remainingMs: number) {
    super(`Circuit breaker is OPEN (${Math.round(remainingMs / 1000)}s remaining)`);
    this.name = 'CircuitOpenError';
  }
}
