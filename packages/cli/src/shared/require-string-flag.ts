/**
 * @dino/cli — reject value-less string flags at the consumption point.
 * `parseFlag` records `true` when no value follows; boolean flags like --quiet are unaffected.
 */

import { CliError } from './errors';

/** Returns undefined when omitted; a non-empty string when valid; throws CliError otherwise. */
export function requireStringFlag(
  name: string,
  value: unknown,
  opts: { requires: string; hint: string },
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new CliError(`${name} requires ${opts.requires}`, 1, opts.hint);
}
