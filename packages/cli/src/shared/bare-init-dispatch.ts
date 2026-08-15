/**
 * #2198 — pre-config init dispatch (runs before loadCliConfig).
 */

import { CliError } from './errors';
import { runInitScanNow, type InitScanNowFlags } from './init-scan-now';
import { runInit } from '../commands/init';

const VALID_FORMATS = new Set(['markdown', 'json']);
type CliOutputFormat = 'markdown' | 'json';

export function resolveInitFormatOrThrow(
  flags: Record<string, unknown>,
): CliOutputFormat | undefined {
  const raw = flags.format as string | undefined;
  if (raw !== undefined && !VALID_FORMATS.has(raw)) {
    throw new CliError(
      `Invalid --format: "${raw}". Valid: markdown, json`,
      2,
      undefined,
      undefined,
      'usage',
    );
  }
  return raw as CliOutputFormat | undefined;
}

export async function dispatchBareInit(
  flags: Record<string, unknown>,
  runBare: (run: () => Promise<number>, bareFlags: Record<string, unknown>) => Promise<number>,
): Promise<number> {
  const format = resolveInitFormatOrThrow(flags);
  const scanNowFlags: InitScanNowFlags = {
    quiet: flags.quiet === true,
    verbose: flags.verbose === true,
    debug: flags.debug === true,
    noColor: flags.noColor === true,
    format,
    env: typeof flags.env === 'string' ? flags.env : undefined,
    header: flags.header as string | string[] | undefined,
    token: typeof flags.token === 'string' ? flags.token : undefined,
  };
  return runBare(
    () =>
      runInit({
        quiet: flags.quiet === true,
        force: flags.force === true,
        yes: flags.yes === true,
        dryRun: flags.dryRun === true,
        ...(format === undefined ? {} : { format }),
        rawFlags: flags,
        onScanNow: () => runInitScanNow(scanNowFlags),
      }),
    flags,
  );
}
