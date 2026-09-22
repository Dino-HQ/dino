/**
 * @dino/cli — reject value-less string flags at the consumption point.
 * `parseFlag` records `true` when no value follows; boolean flags like --quiet are unaffected.
 */

import { CliError } from './errors';

/** Just the three target flags, so this module does not depend on the whole CommonFlags shape. */
export interface TargetFlagSource {
  endpoint?: unknown;
  protocol?: unknown;
  specUrl?: unknown;
}


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

/** Value-less `--endpoint`/`--protocol`/`--spec-url` arrive as boolean `true`: reject them here, not in parseFlag (booleans are valid for --quiet). */
export function requireTargetFlagValues(
  flags: TargetFlagSource,
): { endpointFlag: string | undefined; protocolFlag: string | undefined; specUrlFlag: string | undefined } {
  return {
    endpointFlag: requireStringFlag('--endpoint', flags.endpoint, {
      requires: 'a URL value (e.g. --endpoint https://api.example.com/graphql).',
      hint: 'Pass the endpoint URL immediately after the flag.',
    }),
    protocolFlag: requireStringFlag('--protocol', flags.protocol, {
      requires: 'a value: graphql or rest',
      hint: 'Pass graphql or rest immediately after the flag.',
    }),
    specUrlFlag: requireStringFlag('--spec-url', flags.specUrl, {
      requires: 'a URL or file path value.',
      hint: 'Pass the spec URL or path immediately after the flag.',
    }),
  };
}
