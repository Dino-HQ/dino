/**
 * Global CLI preferences in ~/.dino/config.json (telemetry, anonymous id).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SystemRandom, type RandomSource } from '@dino/engine';

export type TelemetryLevel = 'off' | 'crash' | 'all';

export const TELEMETRY_LEVELS: readonly TelemetryLevel[] = ['off', 'crash', 'all'] as const;

export function isTelemetryLevel(value: string): value is TelemetryLevel {
  return (TELEMETRY_LEVELS as readonly string[]).includes(value);
}

export type DinoGlobalConfig = {
  readonly telemetry?: boolean | TelemetryLevel;
  readonly anonymousId?: string;
};

/**
 * Resolve the effective telemetry level from config.
 * Migrates legacy boolean values: true -> 'all', false -> 'off'.
 * Environment overrides: DO_NOT_TRACK=1 or DINO_TELEMETRY_DISABLED=1 -> 'off'.
 */
export function getEffectiveTelemetryLevel(config: DinoGlobalConfig): TelemetryLevel {
  if (process.env.DO_NOT_TRACK === '1' || process.env.DINO_TELEMETRY_DISABLED === '1') {
    return 'off';
  }
  const val = config.telemetry;
  if (val === undefined) return 'off';
  if (val === true) return 'all';
  if (val === false) return 'off';
  if (isTelemetryLevel(val)) return val;
  return 'off';
}

function resolveDinoHomeDir(): string {
  const override = process.env.DINO_HOME?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return os.homedir();
}

function globalConfigDir(): string {
  return path.join(resolveDinoHomeDir(), '.dino');
}

function globalConfigPath(): string {
  return path.join(globalConfigDir(), 'config.json');
}

export function getGlobalDinoConfigPath(): string {
  return globalConfigPath();
}

export function readGlobalDinoConfigSync(): DinoGlobalConfig {
  const configPath = globalConfigPath();
  try {
    // Path is always $HOME/.dino/config.json (or $DINO_HOME/.dino/config.json).
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename under home
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    return {};
  }
  return {};
}

export function writeGlobalDinoConfigSync(partial: DinoGlobalConfig): void {
  const dir = globalConfigDir();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed .dino under home
  fs.mkdirSync(dir, { recursive: true });
  const configPath = globalConfigPath();
  const prev = readGlobalDinoConfigSync();
  const next: Record<string, unknown> = { ...prev, ...partial };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename under home
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/**
 * Set telemetry level. 'crash' and 'all' ensure a stable anonymous UUID exists.
 */
export function setGlobalTelemetryLevel(
  level: TelemetryLevel,
  random: RandomSource = SystemRandom,
): void {
  const prev = readGlobalDinoConfigSync();
  if (level === 'off') {
    writeGlobalDinoConfigSync({ telemetry: 'off' });
  } else {
    const anonymousId =
      typeof prev.anonymousId === 'string' && prev.anonymousId.length > 0
        ? prev.anonymousId
        : random.uuid();
    writeGlobalDinoConfigSync({ telemetry: level, anonymousId });
  }
}

/** @deprecated Use setGlobalTelemetryLevel. Kept for backward compat. */
export function setGlobalTelemetryEnabled(
  enabled: boolean,
  random: RandomSource = SystemRandom,
): void {
  setGlobalTelemetryLevel(enabled ? 'all' : 'off', random);
}
