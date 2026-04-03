/**
 * Shared clock utilities for agent tools.
 *
 * Agents accept an optional `clock?: AgentClock` field. This module
 * provides the resolution + convenience functions.
 *
 * AgentClock is structurally identical to Clock from src/shared/utils/clock.ts.
 * TypeScript structural typing means any Clock instance satisfies AgentClock.
 * We define it locally to avoid a cross-boundary import from packages/ → src/.
 */

/** Structural mirror of Clock from src/shared/utils/clock.ts */
export interface AgentClock {
  now(): number;
  isoNow(): string;
}

const SystemAgentClock: AgentClock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

/** Resolve clock from options, defaulting to SystemClock */
export function resolveClock(clock?: AgentClock): AgentClock {
  return clock ?? SystemAgentClock;
}

/** Convenience: start a duration measurement */
export function startTimer(clock: AgentClock): () => number {
  const start = clock.now();
  return () => clock.now() - start;
}

/**
 * Structural mirror of Timer from src/shared/utils/timer.ts.
 * Defined locally to avoid cross-boundary import from packages/ → src/.
 * CacheClock, TrackerClock, AgentClock, and AgentTimer are structural mirrors
 * to avoid cross-package imports. TypeScript structural typing ensures
 * SystemTimer/InstantTimer instances satisfy AgentTimer.
 */
export type AgentTimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface AgentTimer {
  setTimeout(callback: () => void, ms: number): AgentTimerHandle;
  clearTimeout(handle: AgentTimerHandle): void;
}

const SystemAgentTimer: AgentTimer = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

/** Resolve timer from options, defaulting to SystemTimer */
export function resolveTimer(timer?: AgentTimer): AgentTimer {
  return timer ?? SystemAgentTimer;
}
