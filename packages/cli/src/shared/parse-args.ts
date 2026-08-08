/**
 * @dino/cli — argv parsing for command + flags.
 */

import { recordSet } from '@dino/core';

function camelCase(flag: string): string {
  return flag.replaceAll(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
}

/** #2160: accumulate repeatable `--header` into string | string[]. */
function accumulateHeaderFlag(flags: Record<string, unknown>, value: string): void {
  const existing = flags.header;
  if (typeof existing === 'string') {
    recordSet(flags, 'header', [existing, value]);
  } else if (Array.isArray(existing)) {
    recordSet(flags, 'header', [...existing, value]);
  } else {
    recordSet(flags, 'header', value);
  }
}

/** Parse a --flag arg, returning the number of consumed tokens. */
function parseFlag(argv: string[], i: number, flags: Record<string, unknown>): number {
  const arg = argv.at(i);
  if (!arg) throw new Error(`parseFlag: argv index ${i} out of bounds (length ${argv.length})`);
  const eq = arg.indexOf('=');
  if (eq > 0) {
    const key = camelCase(arg.slice(2, eq));
    const value = arg.slice(eq + 1);
    if (key === 'header') {
      accumulateHeaderFlag(flags, value);
    } else {
      recordSet(flags, key, value);
    }
    return 1;
  }
  const key = camelCase(arg.slice(2));
  // B27 (#607): Check for single-dash flags (-v, -h) - don't consume them as values
  const nextArg = i + 1 < argv.length ? argv.at(i + 1) : undefined;
  if (nextArg !== undefined && !nextArg.startsWith('-')) {
    if (key === 'header') {
      accumulateHeaderFlag(flags, nextArg);
    } else {
      recordSet(flags, key, nextArg);
    }
    return 2;
  }
  recordSet(flags, key, true);
  return 1;
}

/**
 * #2141: recognize `-h`/`-v` anywhere, not just first position. Without this, `dino login -h`
 * fell through as a positional and STARTED the OAuth flow instead of printing help.
 * Returns true if the arg was a recognized short flag.
 */
function handleShortFlag(arg: string, flags: Record<string, unknown>): boolean {
  if (arg === '-h') {
    recordSet(flags, 'h', true);
    return true;
  }
  if (arg === '-v') {
    recordSet(flags, 'v', true);
    return true;
  }
  return false;
}

/** Record every argument after a `--` terminator as an indexed positional. */
function collectTrailingPositionals(
  argv: string[],
  startIndex: number,
  flags: Record<string, unknown>,
): void {
  for (let i = startIndex; i < argv.length; i++) {
    const positional = argv.at(i);
    if (positional === undefined) {
      throw new Error(
        `Expected positional argument at index ${i} but argv.at(${i}) returned undefined`,
      );
    }
    recordSet(flags, `_${String(i)}`, positional);
  }
}

/**
 * Parse argv: first positional (non-flag) = command; remaining args as flags.
 * Supports --key value, --key=value, --flag (boolean), and -h/-v short flags.
 */
export function parseArgs(argv: string[]): { command: string; flags: Record<string, unknown> } {
  const flags: Record<string, unknown> = {};
  let command = '';
  let i = 0;

  while (i < argv.length) {
    const arg = argv.at(i);
    if (!arg) throw new Error(`parseArgs: argv index ${i} out of bounds (length ${argv.length})`);
    if (arg === '--') {
      i++;
      break;
    }
    if (arg.startsWith('--')) {
      i += parseFlag(argv, i, flags);
      continue;
    }
    if (handleShortFlag(arg, flags)) {
      i++;
      continue;
    }
    if (command) {
      recordSet(flags, `_${String(i)}`, arg);
    } else {
      command = arg;
    }
    i++;
  }

  collectTrailingPositionals(argv, i, flags);
  return { command: command || '', flags };
}
