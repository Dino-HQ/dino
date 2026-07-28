/**
 * #1759 L1+L2 — proportional pre-emptive refresh margin (runner L1).
 */

export const REFRESH_MARGIN_FLOOR_MS = 30_000;
export const REFRESH_MARGIN_CAP_MS = 300_000;
export const REFRESH_MARGIN_PROPORTION = 0.1;

/** clamp(PROPORTION * lifetimeMs, FLOOR, CAP). lifetimeMs <= 0 → FLOOR. */
export function computeRefreshMargin(lifetimeMs: number): number {
  if (lifetimeMs <= 0) {
    return REFRESH_MARGIN_FLOOR_MS;
  }
  const proportional = REFRESH_MARGIN_PROPORTION * lifetimeMs;
  return Math.min(REFRESH_MARGIN_CAP_MS, Math.max(REFRESH_MARGIN_FLOOR_MS, proportional));
}
