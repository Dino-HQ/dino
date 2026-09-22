/**
 * Report scan completion to Dino cloud API (Issue #1178).
 * File name kept for imports; implementation posts to POST /v1/scans/:id/results.
 */

import { SystemTimer } from '@dino/engine';
import type { ScanAttestationWire } from '@dino/core';
import type { Timer } from '@dino/engine';

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 100;

/**
 * Carried by every terminal scan-results POST. `attemptId` is REQUIRED: the URL path names the scan,
 * this names the execution of it, so the cloud can reject a report from a superseded attempt.
 */
export type TerminalReportExtras = {
  attemptId: string;
  rotatedRefreshToken?: string;
  /** Pool identity: scan-bound capability sent as x-dino-scan-capability (Spec B - a pool JWT carries no tenant claim). */
  capabilityToken?: string;
};

/** The completed scan-results POST (Cleanup V2 task 4c): the canonical result and its digest, the minimal DCG, and the optional extras. */
export type ScanCompletedReport = TerminalReportExtras & {
  dcg: unknown;
  dinoResult: string;
  dinoResultDigest: string;
  attestation?: ScanAttestationWire;
  schemaSnapshot?: unknown;
};

/** Fields on the failed scan-results POST (#1759 L3, #30). */
export type ScanFailedExtras = TerminalReportExtras & {
  failureType?: string;
};

/** Fields on the cancelled scan-results POST (live-scan-logs Spec B). */
export type ScanCancelledExtras = TerminalReportExtras;

export interface ScanReporter {
  /** Posts the attempt id, the canonical result bytes + digest, the minimal DCG, and the optional Sigstore bundle / schema snapshot. */
  reportCompleted(scanId: string, report: ScanCompletedReport): Promise<void>;
  /** `failureType` (e.g. `'auth_lost'`) drives cloud-side branching (#1759 L3 re-queue). Omitted → generic failure. */
  reportFailed(scanId: string, reason: string, extras: ScanFailedExtras): Promise<void>;
  /** Terminal cancel (Spec B INV-4): only after the cloud's cancel flag was observed. `toolsCompletedCount: 0` suppresses pool metering (INV-5). */
  reportCancelled(
    scanId: string,
    toolsCompletedCount: number,
    extras: ScanCancelledExtras,
  ): Promise<void>;
}


async function sleepTimer(timer: Timer, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    timer.setTimeout(() => resolve(), ms);
  });
}

/** Options for postScanResultWithRetries. */
export interface PostScanResultWithRetriesOptions {
  url: string;
  runnerToken: string;
  body: Record<string, unknown>;
  httpClient: (url: string, init: RequestInit) => Promise<Response>;
  timer: Timer;
  /** Pool identity: sent as x-dino-scan-capability - without it a pool results POST 401s (Spec B). */
  capabilityToken?: string | undefined;
}

/** Exported for unit tests - wire custom timer for deterministic retries. */
export async function postScanResultWithRetries(
  opts: PostScanResultWithRetriesOptions,
): Promise<void> {
  const { url, runnerToken, body, httpClient, timer } = opts;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${runnerToken}`,
  };
  if (opts.capabilityToken !== undefined) {
    headers['x-dino-scan-capability'] = opts.capabilityToken;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await httpClient(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (res.ok) return;
      lastErr = new Error(`Cloud scan results HTTP ${String(res.status)}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      const delayMs = RETRY_BASE_MS * 2 ** attempt;
      await sleepTimer(timer, delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}


function resultsUrl(cloudEndpoint: string, scanId: string): string {
  const base = cloudEndpoint.replace(/\/$/, '');
  return `${base}/v1/scans/${encodeURIComponent(scanId)}/results`;
}

export function createCloudReporter(
  cloudEndpoint: string,
  runnerToken: string,
  httpClient: (url: string, init: RequestInit) => Promise<Response>,
  timer: Timer = SystemTimer,
): ScanReporter {
  const post = (
    scanId: string,
    body: Record<string, unknown>,
    capabilityToken: string | undefined,
  ): Promise<void> =>
    postScanResultWithRetries({
      url: resultsUrl(cloudEndpoint, scanId),
      runnerToken,
      body,
      httpClient,
      timer,
      capabilityToken,
    });

  return {
    async reportCompleted(scanId: string, report: ScanCompletedReport): Promise<void> {
      const body: Record<string, unknown> = {
        status: 'completed',
        attemptId: report.attemptId,
        dcg: report.dcg,
        dinoResult: report.dinoResult,
        dinoResultDigest: report.dinoResultDigest,
      };
      if (report.attestation !== undefined) body.attestationBundle = report.attestation.bundle;
      if (report.schemaSnapshot !== undefined) body.schemaSnapshot = report.schemaSnapshot;
      if (report.rotatedRefreshToken !== undefined) body.rotatedRefreshToken = report.rotatedRefreshToken;
      await post(scanId, body, report.capabilityToken);
    },

    async reportFailed(scanId: string, reason: string, extras: ScanFailedExtras): Promise<void> {
      const body: Record<string, unknown> = {
        status: 'failed',
        attemptId: extras.attemptId,
        error: reason,
      };
      // #1759 L3 — carry the discriminator the cloud branches on; without it auth_lost re-queue never fires.
      if (extras.failureType !== undefined) body.failureType = extras.failureType;
      if (extras.rotatedRefreshToken !== undefined)
        body.rotatedRefreshToken = extras.rotatedRefreshToken;
      await post(scanId, body, extras.capabilityToken);
    },

    async reportCancelled(
      scanId: string,
      toolsCompletedCount: number,
      extras: ScanCancelledExtras,
    ): Promise<void> {
      const body: Record<string, unknown> = {
        status: 'cancelled',
        attemptId: extras.attemptId,
        toolsCompletedCount,
      };
      if (extras.rotatedRefreshToken !== undefined)
        body.rotatedRefreshToken = extras.rotatedRefreshToken;
      await post(scanId, body, extras.capabilityToken);
    },
  };
}
