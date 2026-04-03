/**
 * PostHogAdapter — STUB.
 *
 * This adapter is a typed placeholder. It logs a one-time warning and no-ops.
 * When the PostHog SDK is installed (future issue), replace the body of track()
 * with actual PostHog capture calls.
 *
 * Expected future dependency: posthog-node
 */

import type { DinoEvent } from '../events';
import type { AnalyticsAdapter } from './types';

export interface PostHogAdapterOptions {
  apiKey: string;
  host?: string;
}

export function createPostHogAdapter(_options: PostHogAdapterOptions): AnalyticsAdapter {
  let warned = false;

  return {
    name: 'posthog',

    track(_event: DinoEvent): void {
      if (!warned) {
        console.warn(
          '[analytics] PostHogAdapter is a stub — install posthog-node to enable production analytics',
        );
        warned = true;
      }
      // No-op until posthog-node is installed
    },

    async shutdown(): Promise<void> {
      // Will call posthog.shutdown() when SDK is installed
    },
  };
}
