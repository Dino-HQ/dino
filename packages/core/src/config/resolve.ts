/**
 * @dino/core — Config resolution (#560).
 * Pure function: merges user .dino.yml over DEFAULT_SCAN_CONFIG.
 * No file I/O, no env reads, no side effects (INV-3).
 */

import { DEFAULT_SCAN_CONFIG } from './defaults';
import type { ScanDefaults, ResolvedScanConfig } from './defaults';

/** Thrown when resolved config violates constraints. */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * User config shape accepted by resolveConfig.
 * Matches DinoCliConfig from @dino/cli but defined here to avoid circular dep.
 * Only the fields resolveConfig cares about — extra fields are ignored.
 */
export interface UserConfigInput {
  endpoint?: string;
  protocol?: 'graphql';
  tenant?: string;
  environment?: string;
  format?: 'json' | 'markdown';
  snapshotDir?: string;
  aiKey?: string;
  autonomy?: { level: 'observe' | 'enforce' };
  auth?: { enabled: boolean; role?: string };
  timeout?: number;
  verbose?: boolean;
}

/**
 * Merge user config over defaults. Pure function (INV-3).
 *
 * Rules:
 * - User-provided values always override defaults (INV-1).
 * - Unknown fields in userConfig are dropped (boundary contract).
 * - Validates constraints: timeoutMs > 0 and finite.
 * - Does NOT validate endpoint URL — that happens at scan boundary (DNS check in createExecutor).
 */
export function resolveConfig(
  userConfig: UserConfigInput | null,
  defaults: ScanDefaults = DEFAULT_SCAN_CONFIG,
): ResolvedScanConfig {
  const user = userConfig ?? {};

  const timeoutMs = user.timeout ?? defaults.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigValidationError(
      `timeoutMs must be a positive finite number, got ${String(timeoutMs)}`,
      'timeoutMs',
    );
  }

  const concurrency = defaults.concurrency;

  return {
    endpoint: user.endpoint,
    protocol: user.protocol ?? defaults.protocol,
    tenant: user.tenant,
    environment: user.environment,
    timeoutMs,
    toolTimeoutMs: defaults.toolTimeoutMs,
    concurrency,
    format: user.format ?? defaults.format,
    outputDir: defaults.outputDir,
    snapshotDir: user.snapshotDir ?? defaults.snapshotDir,
    auth: user.auth?.enabled ? { enabled: true, role: user.auth.role } : undefined,
    aiKey: user.aiKey,
    watchInterval: defaults.watchInterval,
    watchAutonomy: user.autonomy?.level ?? defaults.watchAutonomy,
    requestTimeoutMs: defaults.requestTimeoutMs,
    retries: defaults.retries,
    verbose: user.verbose ?? false,
  };
}
