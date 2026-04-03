/**
 * @dino/cli — binary entry point.
 * This file is the target of package.json "bin" field.
 * NOTE: Do NOT add a shebang here — esbuild injects it via banner config.
 */

import { main } from './index';

void main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
