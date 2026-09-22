/**
 * One-time stderr notice for anonymous CLI telemetry (Next.js parity).
 */

import {
  readGlobalDinoConfigSync,
  writeGlobalDinoConfigSync,
  ensureAnonymousId,
} from './global-dino-config';

/**
 * Print a one-time stderr notice when telemetry preference is unset.
 * Non-blocking, swallow-all — must never crash the host command.
 */
export function maybeShowTelemetryNotice(): void {
  try {
    const cfg = readGlobalDinoConfigSync();
    if (cfg.telemetry !== undefined) return;
    if (cfg.telemetryNoticeShownAt !== undefined) return;
    if (process.env.DO_NOT_TRACK === '1' || process.env.DINO_TELEMETRY_DISABLED === '1') return;

    process.stderr.write(
      `Dino collects anonymous usage data to improve the product.
No API keys, endpoints, or scan results are ever transmitted.
Disable anytime: dino telemetry disable
Learn more: https://usedino.dev/telemetry

`,
    );

    ensureAnonymousId();
    writeGlobalDinoConfigSync({
      telemetryNoticeShownAt: new Date().toISOString(), // determinism:allowed
    });
  } catch {
    void 0;
  }
}
