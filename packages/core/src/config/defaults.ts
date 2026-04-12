/**
 * @dino/core — Smart scan defaults (#560).
 * Pure constant + types. No side effects.
 */

/** Shape of scan defaults. Frozen — tests assert against this. */
export interface ScanDefaults {
  readonly timeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly concurrency: number;
  readonly format: 'json' | 'markdown';
  readonly outputDir: string;
  readonly snapshotDir: string;
  readonly watchInterval: number;
  readonly watchAutonomy: 'observe' | 'enforce';
  readonly protocol: 'graphql';
  readonly requestTimeoutMs: number;
  readonly retries: number;
}

/**
 * Default scan configuration. Applied when user omits a field from `.dino.yml`.
 *
 * Pipeline timeout: 600s — 10 min (#999, generous for slow APIs).
 * Request timeout: 30s (per-request, conservative for unknown APIs).
 * Format: json (machine-readable by default; --format markdown for humans).
 */
export const DEFAULT_SCAN_CONFIG: ScanDefaults = Object.freeze({
  timeoutMs: 600_000,
  toolTimeoutMs: 120_000,
  concurrency: 5,
  format: 'json',
  outputDir: '.dino/reports',
  snapshotDir: '.dino/snapshots',
  watchInterval: 60,
  watchAutonomy: 'observe',
  protocol: 'graphql',
  requestTimeoutMs: 30_000,
  retries: 0,
});

/**
 * Resolved scan configuration — every field guaranteed present after merge.
 * Used by scan.ts and watch.ts to read config without null checks.
 */
export interface ResolvedScanConfig {
  /** Direct endpoint URL (ad-hoc mode) or undefined (tenant mode) */
  endpoint?: string;
  /** API protocol */
  protocol: 'graphql';
  /** Tenant ID (undefined in ad-hoc mode) */
  tenant?: string;
  /** Environment name */
  environment?: string;
  /** Overall pipeline timeout ms */
  timeoutMs: number;
  /** Per-tool timeout ms */
  toolTimeoutMs: number;
  /** Max concurrent API requests */
  concurrency: number;
  /** Output format */
  format: 'json' | 'markdown';
  /** Report output directory */
  outputDir: string;
  /** Snapshot directory */
  snapshotDir: string;
  /** Auth configuration (undefined = no auth = skip RBAC) */
  auth?: { enabled: boolean; role?: string };
  /** AI API key for reasoning */
  aiKey?: string;
  /** Watch interval in seconds */
  watchInterval: number;
  /** Watch autonomy level */
  watchAutonomy: 'observe' | 'enforce';
  /** Per-request timeout ms (used in ad-hoc EnvironmentConfig) */
  requestTimeoutMs: number;
  /** Retries on request failure */
  retries: number;
  /** Verbose output enabled */
  verbose: boolean;
}
