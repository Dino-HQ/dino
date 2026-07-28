/**
 * Runner process lifecycle: graceful-shutdown signal handling + cleanup. Split out of
 * commands/runner.ts so that file stays under the 400-line cap (#70).
 */

import { unrefHandle, type Timer } from '@dino/engine';

export type RunnerShutdown = {
  signal: AbortSignal;
  onSignal: () => void;
  getHandle: () => ReturnType<Timer['setTimeout']> | undefined;
};

function createHardShutdownHandler(
  controller: AbortController,
  timer: Timer,
  hardShutdownMs: number,
  hardShutdownUnref: boolean,
): { onSignal: () => void; getHandle: () => ReturnType<Timer['setTimeout']> | undefined } {
  let hardHandle: ReturnType<Timer['setTimeout']> | undefined;
  const onSignal = (): void => {
    controller.abort();
    if (hardHandle !== undefined) {
      return;
    }
    hardHandle = timer.setTimeout(() => {
      console.error(JSON.stringify({ event: 'hard_shutdown', after_ms: hardShutdownMs }));
      process.exit(1);
    }, hardShutdownMs);
    if (hardShutdownUnref) {
      unrefHandle(hardHandle);
    }
  };
  return { onSignal, getHandle: () => hardHandle };
}

/** Wire SIGINT/SIGTERM → abort, with a hard-shutdown fallback timer. Returns the abort signal + cleanup handles. */
export function installRunnerSignalHandlers(
  timer: Timer,
  opts: { hardShutdownMs?: number | undefined; hardShutdownTimerUnref?: boolean | undefined },
): RunnerShutdown {
  const controller = new AbortController();
  const { onSignal, getHandle } = createHardShutdownHandler(
    controller,
    timer,
    opts.hardShutdownMs ?? 30_000,
    opts.hardShutdownTimerUnref ?? true,
  );
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return { signal: controller.signal, onSignal, getHandle };
}

/** Tear down the shutdown handlers + the (optional #70) wake server. */
export function cleanupRunner(
  timer: Timer,
  shutdown: RunnerShutdown,
  wakeServer: { close: () => void } | undefined,
): void {
  const hardHandle = shutdown.getHandle();
  if (hardHandle !== undefined) timer.clearTimeout(hardHandle);
  wakeServer?.close();
  process.off('SIGINT', shutdown.onSignal);
  process.off('SIGTERM', shutdown.onSignal);
}
