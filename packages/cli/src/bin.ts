/**
 * @dino/cli - binary entry point.
 * This file is the target of package.json "bin" field.
 * NOTE: Do NOT add a shebang here - esbuild injects it via banner config.
 */

import { main } from './index';
import {
  canonicalFailureMessage,
  emitEnvelope,
  envelopeFor,
  outcomeFromCaughtError,
  resolveExitCode,
} from './shared/outcome';

void main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (err) => {
    // #2200: honor escaped CliError.kind (usage/config/…) — never force crash.
    const outcome = outcomeFromCaughtError(err);
    const code = resolveExitCode(outcome);
    // D5: the top-level prose and the envelope render the same canonical message.
    console.error(outcome.error?.message ?? canonicalFailureMessage(err));
    emitEnvelope(envelopeFor(outcome, code));
    process.exitCode = code;
  },
);
