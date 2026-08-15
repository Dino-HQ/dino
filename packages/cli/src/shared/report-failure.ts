/**
 * Canonical CLI failure emission (#2196).
 * Caught error → documented exit code + stderr envelope.
 */

import { emitEnvelope, envelopeFor, outcomeFromCaughtError, resolveExitCode } from './outcome';
import { detectUi, printError } from './ui';

/** Canonical CLI failure emission: caught error → documented exit code + stderr envelope. */
export function reportCaughtFailure(err: unknown, flags: Record<string, unknown>): number {
  const outcome = outcomeFromCaughtError(err);
  const code = resolveExitCode(outcome);
  const ui = detectUi({
    quiet: false,
    noColor: flags.noColor === true,
  });
  // INV-2: printError must not be gated by quiet — quiet suppresses chrome, never errors.
  printError(err instanceof Error ? err : new Error(String(err)), ui, flags.debug === true);
  emitEnvelope(envelopeFor(outcome, code));
  return code;
}
