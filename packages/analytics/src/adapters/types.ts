/**
 * @dino/analytics — Adapter contract
 *
 * Every analytics adapter must implement this interface.
 * Adapters are synchronous-fire-and-forget by design — analytics
 * must NEVER block the pipeline or throw to callers.
 */

import type { DinoEvent } from '../events';

export interface AnalyticsAdapter {
  /** Human-readable name for logging (e.g., 'console', 'posthog', 'noop') */
  readonly name: string;

  /**
   * Send an event to the analytics backend.
   * Implementations MUST NOT throw — swallow errors internally.
   */
  track(event: DinoEvent): void;

  /**
   * Optional cleanup (e.g., flush pending batches).
   * Called on graceful shutdown.
   */
  shutdown?(): Promise<void>;
}
