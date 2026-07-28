/**
 * `dino config telemetry [off|crash|all]` — manage CLI telemetry preference.
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

function printTelemetryStatus(): void {
  const cfg = readGlobalDinoConfigSync();
  const effective = getEffectiveTelemetryLevel(cfg);
  const envOverride =
    process.env.DO_NOT_TRACK === '1' || process.env.DINO_TELEMETRY_DISABLED === '1';

  if (cfg.telemetry === undefined) {
    console.info('Telemetry: unset (off until you opt in on first interactive scan)');
  } else {
    console.info(`Telemetry: ${effective}`);
  }

  if (envOverride) {
    console.info('  (overridden to off by environment variable)');
  }

  console.info('');
  console.info('Levels:');
  console.info('  off   — nothing sent');
  console.info('  crash — only error/crash reports');
  console.info('  all   — full usage analytics');
}

/**
 * Entry for `dino config ...` subcommands. `argv` is e.g. `['config','telemetry','crash']`.
 */
export async function runConfigFromArgv(argv: string[]): Promise<number> {
  const sub = argv.at(1);
  const action = argv.at(2);

  if (sub !== 'telemetry') {
    console.error('Usage: dino config telemetry [off|crash|all]');
    return 1;
  }

  if (action === undefined || action === '') {
    printTelemetryStatus();
    return 0;
  }

  const lower = action.toLowerCase();

  // Backward compat: 'on' maps to 'all'
  const mapped = lower === 'on' ? 'all' : lower;

  if (!isTelemetryLevel(mapped)) {
    console.error(`Unknown telemetry level: "${action}"`);
    console.error('Usage: dino config telemetry [off|crash|all]');
    return 1;
  }

  setGlobalTelemetryLevel(mapped);
  if (mapped === 'off') {
    console.info('Telemetry disabled.');
  } else if (mapped === 'crash') {
    console.info('Telemetry set to crash — only error reports will be sent.');
  } else {
    console.info('Telemetry enabled — full usage analytics.');
  }
  return 0;
}
