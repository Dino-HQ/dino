/**
 * `dino config telemetry [off|crash|all]` — manage CLI telemetry preference.
 * `dino telemetry status|enable|disable` — top-level telemetry control.
 *
 * Levels:
 *   off   — nothing sent
 *   crash — only error/crash reports
 *   all   — full usage analytics
 */

import {
  getEffectiveTelemetryLevel,
  isTelemetryLevel,
  readGlobalDinoConfigSync,
  setGlobalTelemetryLevel,
} from '../config/global-dino-config';
import { CliError } from '../shared/errors';

function printTelemetryStatus(): void {
  const cfg = readGlobalDinoConfigSync();
  const effective = getEffectiveTelemetryLevel(cfg);
  const envOverride =
    process.env.DO_NOT_TRACK === '1' || process.env.DINO_TELEMETRY_DISABLED === '1';

  if (cfg.telemetry === undefined) {
    console.info('Telemetry: on (anonymous usage) - disable with `dino telemetry disable`');
  } else {
    console.info(`Telemetry: ${effective}`);
  }

  if (envOverride) {
    console.info('  (overridden to off by environment variable)');
  }

  console.info('');
  console.info('Levels:');
  console.info('  off   - nothing sent');
  console.info('  crash - only error/crash reports');
  console.info('  all   - full usage analytics');
}

/**
 * Entry for `dino telemetry ...` subcommands. `argv` is e.g. `['telemetry','disable']`.
 */
export async function runTelemetryFromArgv(argv: string[]): Promise<number> {
  const sub = argv.at(1);

  if (sub === undefined || sub === '' || sub === 'status') {
    printTelemetryStatus();
    return 0;
  }

  const lower = sub.toLowerCase();

  if (lower === 'enable') {
    setGlobalTelemetryLevel('all');
    console.info('Telemetry enabled: full usage analytics.');
    return 0;
  }

  if (lower === 'disable') {
    setGlobalTelemetryLevel('off');
    console.info('Telemetry disabled.');
    return 0;
  }

  throw new CliError(
    `Unknown telemetry subcommand: "${sub}"`,
    2,
    'Usage: dino telemetry status|enable|disable',
    undefined,
    'usage',
  );
}

/**
 * Entry for `dino config ...` subcommands. `argv` is e.g. `['config','telemetry','crash']`.
 */
export async function runConfigFromArgv(argv: string[]): Promise<number> {
  const sub = argv.at(1);
  const action = argv.at(2);

  if (sub !== 'telemetry') {
    throw new CliError(
      'Usage: dino config telemetry [off|crash|all]',
      2,
      undefined,
      undefined,
      'usage',
    );
  }

  if (action === undefined || action === '') {
    printTelemetryStatus();
    return 0;
  }

  const lower = action.toLowerCase();

  // Backward compat: 'on' maps to 'all'
  const mapped = lower === 'on' ? 'all' : lower;

  if (!isTelemetryLevel(mapped)) {
    throw new CliError(
      `Unknown telemetry level: "${action}"`,
      2,
      'Usage: dino config telemetry [off|crash|all]',
      undefined,
      'usage',
    );
  }

  setGlobalTelemetryLevel(mapped);
  if (mapped === 'off') {
    console.info('Telemetry disabled.');
  } else if (mapped === 'crash') {
    console.info('Telemetry set to crash: only error reports will be sent.');
  } else {
    console.info('Telemetry enabled: full usage analytics.');
  }
  return 0;
}
