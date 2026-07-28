/**
 * Scan budget / cloud-wait timing contract (F5, PR2 of the scan-budget train).
 *
 * One scan is governed by three timeouts in two packages that must stay reconciled. These constants
 * are the single source of truth that both @dino/engine (the per-scan pipeline budget) and
 * @dino/cloud (the runner-wait + stale-reaper) import via the @dino/core barrel. The drift-guard
 * tests (INV-1/2/3) fail CI if any of the three ever falls out of order.
 *
 * Ordering invariant: engine budget + upload margin ≤ runner-wait ≤ stale-reaper.
 */

/** The cloud waits this long for an assigned runner to report completion (the `waitForEvent` in
 *  @dino/cloud run-scan). Hard outer bound — a runner MUST finish its pipeline AND upload within it. */
export const CLOUD_RUNNER_WAIT_MS = 900_000; // 15 min

/** Reserved for the runner to upload the result blob + emit `scan/runner.completed` after the pipeline. */
export const RESULT_UPLOAD_MARGIN_MS = 120_000; // 2 min

/** The largest per-scan pipeline budget the engine may grant. INV-1 by construction:
 *  MAX_ENGINE_SCAN_BUDGET_MS + RESULT_UPLOAD_MARGIN_MS === CLOUD_RUNNER_WAIT_MS. */
export const MAX_ENGINE_SCAN_BUDGET_MS = CLOUD_RUNNER_WAIT_MS - RESULT_UPLOAD_MARGIN_MS; // 780_000 (13 min)
