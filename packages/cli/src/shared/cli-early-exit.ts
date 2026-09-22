/**
 * @dino/cli - version/help early exit handling (#173, #2141).
 * @internal Extracted from index.ts for max-lines compliance.
 */

import { quickstartText, usageText } from './cli-usage';
import { printCommandHelp } from './command-help';
import { emitResult } from './emit-result';
import { CLI_VERSION } from '../version';

function printUsage(opts?: { stream?: 'stdout' | 'stderr' }): void {
  if (opts?.stream === 'stderr') {
    console.error(usageText());
    return;
  }
  emitResult(usageText());
}

/** Check if argv requests version or help output. Returns exit code 0 if handled, null otherwise. */
export function handleEarlyExit(
  command: string | undefined,
  flags: Record<string, unknown>,
): number | null {
  if (
    flags.version === true ||
    flags.v === true ||
    command === '--version' ||
    command === '-v' ||
    command === 'version'
  ) {
    emitResult(CLI_VERSION);
    return 0;
  }
  const helpRequested =
    flags.help === true ||
    flags.h === true ||
    command === '--help' ||
    command === '-h' ||
    command === 'help';
  if (helpRequested) {
    const named =
      command !== undefined && command !== '--help' && command !== '-h' && command !== 'help';
    if (named && printCommandHelp(command)) {
      return 0;
    }
    printUsage();
    return 0;
  }
  if (!command) {
    emitResult(quickstartText());
    return 0;
  }
  return null;
}

export function printUsageToStream(opts?: { stream?: 'stdout' | 'stderr' }): void {
  printUsage(opts);
}
