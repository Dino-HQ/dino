/** Live scan-log emission and cancel observation for one runner scan (Spec B). */

import { startCancelWatch } from './cancel-watch';
import { createScanLogEmitter } from './log-emitter';
import type { ScanExecuteDeps } from './runner-scan-execute';

export type LiveScanWires = {
  emitter: ReturnType<typeof createScanLogEmitter>;
  watch: { stop: () => void };
  signal: AbortSignal;
  cancelObserved: () => boolean;
};

/**
 * Live emission + cancel observation (Spec B). Both are best-effort and NEVER fail the scan
 * (INV-1); the abort controller is fired ONLY by an observed cloud cancel flag (INV-4).
 */
export function startLiveScanWires(opts: ScanExecuteDeps): LiveScanWires {
  const controller = new AbortController();
  let cancelObserved = false;
  const common = {
    cloudEndpoint: opts.state.cloudEndpoint,
    runnerToken: opts.state.token,
    capabilityToken: opts.assignment.capabilityToken,
    scanId: opts.assignment.scanId,
    attemptId: opts.assignment.attemptId,
    httpClient: opts.cloudHttpClient,
    timer: opts.timer,
  };
  const emitter = createScanLogEmitter(common);
  const watch = startCancelWatch({
    ...common,
    onCancel: () => {
      cancelObserved = true;
      controller.abort();
    },
  });
  return { emitter, watch, signal: controller.signal, cancelObserved: () => cancelObserved };
}

