/**
 * ConsoleAdapter — logs events to stderr (#995).
 * Used in development (`DINO_ENV=dev`).
 * Writes to stderr so stdout contains only the scan report.
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
        // #995: stderr so `dino scan | less` works cleanly

        console.error(`[analytics] ${type}`, {
          ...properties,
          timestamp,
          tenantId,
        });
      } catch (error_: unknown) {
        // Analytics must never throw — swallow all errors to avoid crashing the CLI.
        // Log to stderr as last resort (console.error itself could throw, but extremely unlikely).
        if (error_ instanceof Error) {
          process.stderr.write(`[analytics] track error: ${error_.message}\n`);
        }
      }
    },
  };
}
