/**
 * Sole stdout result writer for the CLI (INV-1, #2172).
 * Notices/progress/logs must never call this - they use ui.ts / the engine logger (stderr).
 */

import { stripControlsAndAnsi } from './neutralize';

export interface EmitResultOptions {
  format?: 'markdown' | 'json';
  /** Override TTY detection (defaults to process.stdout.isTTY - same seam as detectUi). */
  tty?: boolean;
}

/** Default sink: the real stdout. */
const defaultSink = (s: string): void => {
  process.stdout.write(s);
};

/**
 * The single stdout writer emitResult routes through (INV-1). Injectable so tests can
 * capture result output deterministically WITHOUT spying on the global `process.stdout.write`
 * (that global spy bled across tests under sharded/randomized runs — #2172 isolation bug).
 */
let resultSink: (s: string) => void = defaultSink;

/**
 * Test seam (HC #31): redirect emitResult's stdout writes to `sink`.
 * Pass `null` to restore the real stdout writer. Production code never calls this.
 */
export function setResultSink(sink: ((s: string) => void) | null): void {
  resultSink = sink ?? defaultSink;
}

/**
 * Write exactly one result document to stdout.
 * Strips ANSI when not a TTY (piped / redirected). Ensures a single trailing `\n`.
 */
export function emitResult(document: string, opts?: EmitResultOptions): void {
  const tty = opts?.tty ?? process.stdout.isTTY === true;
  let out = document;
  if (!tty || opts?.format === 'json') {
    out = stripControlsAndAnsi(out);
  }
  if (!out.endsWith('\n')) {
    out = `${out}\n`;
  }
  resultSink(out);
}
