/**
 * One-time interactive consent before the first `dino scan` when telemetry is unset.
 */

import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { SystemRandom, type RandomSource } from '@dino/engine';
import {
  readGlobalDinoConfigSync,
  setGlobalTelemetryLevel,
  type TelemetryLevel,
} from './global-dino-config';

/**
 * Prompts for telemetry on first interactive scan when preference is unset.
 * Non-interactive environments default telemetry to off without prompting.
 *
 * Options:
 *   [a]ll   — full usage analytics (default on Enter)
 *   [c]rash — error reports only
 *   [n]o    — nothing sent
 */
export async function ensureScanTelemetryConsent(
  random: RandomSource = SystemRandom,
): Promise<void> {
  const cfg = readGlobalDinoConfigSync();
  if (cfg.telemetry !== undefined) {
    return;
  }

  // CI and non-interactive: default to off silently
  if (!input.isTTY || process.env.CI === 'true') {
    setGlobalTelemetryLevel('off', random);
    return;
  }

  // DO_NOT_TRACK takes precedence
  if (process.env.DO_NOT_TRACK === '1' || process.env.DINO_TELEMETRY_DISABLED === '1') {
    setGlobalTelemetryLevel('off', random);
    return;
  }

  console.info(`Dino collects anonymous usage data to improve the product.
No API keys, endpoints, or scan results are ever transmitted.

  [a]ll   - full usage analytics (default)
  [c]rash - error reports only
  [n]o    - nothing sent

Run dino config telemetry off to change later.
`);

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('[A/c/n] ');
    const normalized = answer.trim().toLowerCase();

    let level: TelemetryLevel;
    if (
      normalized === '' ||
      normalized === 'a' ||
      normalized === 'all' ||
      normalized === 'y' ||
      normalized === 'yes'
    ) {
      level = 'all';
    } else if (normalized === 'c' || normalized === 'crash') {
      level = 'crash';
    } else {
      level = 'off';
    }

    setGlobalTelemetryLevel(level, random);
  } finally {
    rl.close();
  }
}
