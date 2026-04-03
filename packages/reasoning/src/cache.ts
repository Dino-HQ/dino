/**
 * @dino/reasoning — TTL cache for reasoning outcomes
 *
 * Used by the engine to avoid duplicate LLM calls for identical requests.
 */

import type { ReasoningOutcome } from './types';

/** Structural mirror of Clock from src/shared/utils/clock.ts */
export interface CacheClock {
  now(): number;
}

const SystemCacheClock: CacheClock = { now: () => Date.now() }; // determinism:seam

export interface CacheOptions {
  /** TTL in milliseconds */
  ttlMs: number;
  /** Maximum cache entries (default 100) */
  maxEntries?: number;
  /** Injectable clock for deterministic TTL in tests. Default: SystemClock */
  clock?: CacheClock;
}

export interface ReasoningCache {
  get<T>(key: string): ReasoningOutcome<T> | undefined;
  set<T>(key: string, value: ReasoningOutcome<T>): void;
  clear(): void;
  readonly size: number;
}

interface CacheEntry {
  value: ReasoningOutcome<unknown>;
  expiresAt: number;
}

/**
 * Creates a TTL-based in-memory cache for reasoning outcomes.
 */
export function createReasoningCache(options: CacheOptions): ReasoningCache {
  const { ttlMs, maxEntries = 100, clock: optClock } = options;
  const clock = optClock ?? SystemCacheClock;
  const store = new Map<string, CacheEntry>();

  return {
    get<T>(key: string): ReasoningOutcome<T> | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= clock.now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value as ReasoningOutcome<T>;
    },

    set<T>(key: string, value: ReasoningOutcome<T>): void {
      // B105 (#674): Sweep expired entries before checking size limit.
      // Prevents premature eviction of valid entries when expired ones accumulate.
      const now = clock.now();
      for (const [k, entry] of store) {
        if (entry.expiresAt <= now) store.delete(k);
      }
      if (store.size >= maxEntries) {
        const firstKey = store.keys().next().value;
        if (firstKey !== undefined) {
          store.delete(firstKey);
        }
      }
      store.set(key, {
        value: value as ReasoningOutcome<unknown>,
        expiresAt: clock.now() + ttlMs,
      });
    },

    clear(): void {
      store.clear();
    },

    get size(): number {
      return store.size;
    },
  };
}
