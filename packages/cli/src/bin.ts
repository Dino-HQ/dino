/**
 * @dino/cli - binary entry point.
 * This file is the target of package.json "bin" field.
 * NOTE: Do NOT add a shebang here - esbuild injects it via banner config.
 */

import {
  emitEnvelope,
  envelopeFor,
  outcomeFromCaughtError,
  resolveExitCode,
} from './shared/outcome';
import { humanizeError } from './shared/ui';
import { main } from './index';

void main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (err) => {
    // #174: humanize known node/network errors at the top-level boundary
    console.error(humanizeError(err));
    // #2200: honor escaped CliError.kind (usage/config/…) — never force crash
    const outcome = outcomeFromCaughtError(err);
    const code = resolveExitCode(outcome);
    emitEnvelope(envelopeFor(outcome, code));
    process.exitCode = code;
  },
);
