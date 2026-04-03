/**
 * ConsoleAdapter — logs events to stdout.
 * Used in development (`DINO_ENV=dev`).
 */

import type { DinoEvent } from '../events';
import type { AnalyticsAdapter } from './types';

export function createConsoleAdapter(): AnalyticsAdapter {
  return {
    name: 'console',
    track(event: DinoEvent): void {
      try {
        const { type, timestamp, tenantId, properties } = event as DinoEvent & {
          properties: Record<string, unknown>;
        };
        // eslint-disable-next-line no-console
        console.log(`[analytics] ${type}`, {
          ...properties,
          timestamp,
          tenantId,
        });
      } catch {
        // Never throw from analytics
      }
    },
  };
}
