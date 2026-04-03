/**
 * NoopAdapter — discards all events silently.
 * Used in test environments and when analytics is disabled.
 */

import type { AnalyticsAdapter } from './types';

export function createNoopAdapter(): AnalyticsAdapter {
  return {
    name: 'noop',
    track(): void {
      // Intentionally empty
    },
  };
}
