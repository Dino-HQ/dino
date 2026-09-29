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
  // D5: the prose renders the same canonical message the envelope carries (outcome.error.message),
  // so the two can never disagree. INV-2: printError is not gated by quiet.
  printError(
    err instanceof Error ? err : new Error(String(err)),
    ui,
    flags.debug === true,
    outcome.error?.message,
  );
  emitEnvelope(envelopeFor(outcome, code));
  return code;
}
