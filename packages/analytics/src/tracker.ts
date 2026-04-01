/**
 * @dino/analytics — Tracker
 *
 * Thin wrapper around an AnalyticsAdapter. Provides:
 * - Auto-timestamping
 * - Global tenantId binding
 * - Error swallowing (analytics must never crash the host)
 */

import type { DinoEvent } from './events';
import type { AnalyticsAdapter } from './adapters/types';

/** Structural mirror of Clock from src/shared/utils/clock.ts */
interface TrackerClock {
  isoNow(): string;
}

const SystemTrackerClock: TrackerClock = { isoNow: () => new Date().toISOString() }; // determinism:seam

export interface TrackerOptions {
  adapter: AnalyticsAdapter;
  /** Default tenantId applied to all events (can be overridden per-event) */
  tenantId?: string;
  /** Optional callback for tracking errors (default: console.error) */
  onError?: (error: unknown, metadata?: Record<string, unknown>) => void;
  /** Injectable clock for deterministic timestamps. Default: SystemClock */
  clock?: TrackerClock;
}

export interface Tracker {
  /**
   * Send a typed analytics event.
   * Auto-adds timestamp if not present. Auto-adds tenantId if configured.
   * Never throws.
   */
  track(event: DinoEvent): void;

  /**
   * Gracefully shut down the tracker (flushes adapter).
   */
  shutdown(): Promise<void>;
}

export function createTracker(options: TrackerOptions): Tracker {
  const { adapter, tenantId: defaultTenantId } = options;
  const clock = options.clock ?? SystemTrackerClock;

  return {
    track(event: DinoEvent): void {
      try {
        const enriched: DinoEvent = {
          ...event,
          timestamp: event.timestamp ?? clock.isoNow(),
          ...(defaultTenantId && !event.tenantId ? { tenantId: defaultTenantId } : {}),
        } as DinoEvent;

        adapter.track(enriched);
      } catch (err) {
        if (options.onError) {
          options.onError(err, { event });
        } else {
          const adapterName = adapter.constructor?.name || 'unknown';
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Tracker] ${adapterName} error tracking "${event.type}": ${msg}`);
        }
      }
    },

    async shutdown(): Promise<void> {
      try {
        await adapter.shutdown?.();
      } catch {
        // Swallow shutdown errors
      }
    },
  };
}
