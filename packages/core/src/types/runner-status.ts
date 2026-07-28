/**
 * Runner and managed runner lifecycle status types.
 */

/** Self-hosted/registered runner status. One-way: active → revoked. */
export type RunnerStatus = 'active' | 'revoked';

/** All valid runner statuses as a const tuple — drift from RunnerStatus union is a compile error. */
export const RUNNER_STATUSES = ['active', 'revoked'] as const satisfies readonly RunnerStatus[];

/**
 * Managed runner cloud lifecycle status (GCP Cloud Run).
 *
 * State diagram:
 *   deploying → provisioning → active ↔ stopped
 *                                     → error
 */
export type ManagedRunnerCloudStatus =
  | 'deploying'
  | 'provisioning'
  | 'active'
  | 'stopped'
  | 'error'
  | 'offline';

/** All valid managed runner cloud statuses as a const tuple — drift from union is a compile error. */
export const MANAGED_RUNNER_CLOUD_STATUSES = [
  'deploying',
  'provisioning',
  'active',
  'stopped',
  'error',
  'offline',
] as const satisfies readonly ManagedRunnerCloudStatus[];
