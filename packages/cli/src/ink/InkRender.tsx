import { render } from 'ink';
import type { UiOptions } from '../shared/ui';
import type { ReactNode } from 'react';

/**
 * True when Ink summary views may render (TTY, not quiet, not JSON format).
 * Issue #1014 INV-1, INV-3.
 */
export function shouldRenderInkView(
  ui: UiOptions,
  options: { format?: string | undefined; quiet?: boolean | undefined },
): boolean {
  if (options.quiet) {
    return false;
  }
  if (options.format === 'json') {
    return false;
  }
  return ui.ink === true;
}

/**
 * Render an Ink tree to stdout, then unmount after a short delay.
 * Caller must gate with shouldRenderInkView / ui.ink.
 *
 * INV-4 #1014: unmount after flush — timer is intentional (Ink frame commit).
 */
export function renderView(element: ReactNode): void {
  const { unmount } = render(element);
  globalThis.setTimeout(() => {
    unmount();
  }, 50); // determinism:allowed
}

/**
 * Try renderView; return false if render throws (yoga / Ink failure).
 */
export function renderViewSafe(element: ReactNode): boolean {
  try {
    renderView(element);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    console.debug(`[dino] Ink render failed: ${msg}`);
    return false;
  }
}

/**
 * Wait until the Ink app exits, with a safety unmount timeout.
 * Rendered root should call useApp().exit() when finished.
 */
/**
 * Returns true if exited normally, false if the 30s safety timeout fired.
 */
export async function renderViewAsync(element: ReactNode): Promise<boolean> {
  const { unmount, waitUntilExit } = render(element);
  let timedOut = false;
  const safetyTimeout = globalThis.setTimeout(() => {
    timedOut = true;

    console.debug('[dino] Ink view timed out after 30s — forcing unmount');
    unmount();
  }, 30_000); // determinism:allowed
  try {
    await waitUntilExit();
  } finally {
    clearTimeout(safetyTimeout);
  }
  return !timedOut;
}
