/**
 * Scan lifecycle state machine.
 *
 * State diagram:
 *   requested → queued → running → completed
 *                     → failed (capacity: no runner ever claimed)
 *            → running → failed → requested (retry, max 3)
 *            → running → cancelled (cancel_requested_at flag observed by the
 *                        runner between tools; terminal state is set ONLY by the
 *                        runner's terminal report — the cancel route sets the flag)
 *
 * `queued` (#70) = assigned to a runner but NOT yet claimed. A scan is `running`
 * ONLY after a runner has actually claimed it (polled/woken and taken ownership);
 * assignment alone leaves it `queued`. A `queued → failed` timeout is a capacity
 * failure (no runner became available), distinct from a ran-then-failed scan.
 *
 * Discriminated union enforces state-dependent field access:
 * - resultKey only exists on completed scans
 * - assignedRunnerId is required on queued and running scans
 * - failureType only exists on failed scans
 */

import type { RunnerId, ScanId, TenantId } from './ids';

/** The six valid scan states. */
export type ScanStatus = 'requested' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** All valid scan statuses as a const tuple — drift from ScanStatus union is a compile error. */
export const SCAN_STATUSES = [
  'requested',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly ScanStatus[];

/** Base fields present on every scan regardless of status. */
interface ScanStateBase {
  id: ScanId;
  tenantId: TenantId;
  targetUrl: string;
}

/**
 * Discriminated union for scan state — each status carries only the fields
 * valid for that state. Accessing `resultKey` on a non-completed scan is
 * a compile error.
 */
export type ScanState =
  | (ScanStateBase & {
      status: 'requested';
      assignedRunnerId?: undefined;
      resultKey?: undefined;
      failureType?: undefined;
    })
  | (ScanStateBase & {
      status: 'queued';
      assignedRunnerId: RunnerId; // assigned at queue time (INV-1); flips to running on claim
      resultKey?: undefined;
      failureType?: undefined;
    })
  | (ScanStateBase & {
      status: 'running';
      assignedRunnerId: RunnerId;
      resultKey?: undefined;
      failureType?: undefined;
    })
  | (ScanStateBase & {
      status: 'completed';
      assignedRunnerId?: RunnerId | undefined;
      resultKey: string;
      failureType?: undefined;
    })
  | (ScanStateBase & {
      status: 'failed';
      assignedRunnerId?: RunnerId | undefined;
      resultKey?: undefined;
      failureType?: string | undefined;
    })
  | (ScanStateBase & {
      status: 'cancelled';
      assignedRunnerId?: RunnerId | undefined;
      resultKey?: undefined;
      failureType?: undefined;
    });
