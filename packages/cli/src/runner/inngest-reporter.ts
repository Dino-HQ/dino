/**
 * Report scan completion to Dino cloud API (Issue #1178).
 * File name kept for imports; implementation posts to POST /v1/scans/:id/results.
 */

import { SystemTimer } from '@dino/engine';
import type { ScanAttestationWire } from '@dino/core';
import type { Timer } from '@dino/engine';

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 100;

/** Optional fields on the completed scan-results POST (#1154, #1234, #1759 #30). */
export type ScanCompletedExtras = {
  attestation?: ScanAttestationWire;
  pipelineResult?: unknown;
  rotatedRefreshToken?: string;
  /** Pool identity: scan-bound capability sent as x-dino-scan-capability (Spec B - a pool JWT carries no tenant claim). */
  capabilityToken?: string;
};

/** Optional fields on the failed scan-results POST (#1759 L3, #30). */
export type ScanFailedExtras = {
  failureType?: string;
  rotatedRefreshToken?: string;
  /** Pool identity: scan-bound capability sent as x-dino-scan-capability (Spec B). */
  capabilityToken?: string;
};

/** Optional fields on the cancelled scan-results POST (live-scan-logs Spec B). */
export type ScanCancelledExtras = {
  rotatedRefreshToken?: string;
  /** Pool identity: scan-bound capability sent as x-dino-scan-capability (Spec B). */
  capabilityToken?: string;
};

export interface ScanReporter {
  /** Posts DCG JSON plus optional Sigstore bundle (#1154). Optional `pipelineResult` hydrates dashboard materialization (#1234). */
  reportCompleted(scanId: string, dcg: unknown, extras?: ScanCompletedExtras): Promise<void>;
  /** `failureType` (e.g. `'auth_lost'`) drives cloud-side branching (#1759 L3 re-queue). Omitted → generic failure. */
  reportFailed(scanId: string, reason: string, extras?: ScanFailedExtras): Promise<void>;
  /** Terminal cancel (Spec B INV-4): only after the cloud's cancel flag was observed. `toolsCompletedCount: 0` suppresses pool metering (INV-5). */
  reportCancelled(
    scanId: string,
    toolsCompletedCount: number,
    extras?: ScanCancelledExtras,
  ): Promise<void>;
}

/** @deprecated Use ScanReporter */
export type InngestReporter = ScanReporter;

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

/** @deprecated Use postScanResultWithRetries */
export { postScanResultWithRetries as postInngestEventWithRetries };

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
    async reportCompleted(
      scanId: string,
      dcg: unknown,
      extras?: ScanCompletedExtras,
    ): Promise<void> {
      const body: Record<string, unknown> = { status: 'completed', dcg };
      // Large optional payload — cloud applies INV-8 size guard + INV-9 redaction server-side.
      if (extras?.pipelineResult !== undefined) body.result = extras.pipelineResult;
      if (extras?.attestation) body.attestationBundle = extras.attestation.bundle;
      if (extras?.rotatedRefreshToken !== undefined)
        body.rotatedRefreshToken = extras.rotatedRefreshToken;
      await post(scanId, body, extras?.capabilityToken);
    },

    async reportFailed(scanId: string, reason: string, extras?: ScanFailedExtras): Promise<void> {
      const body: Record<string, unknown> = { status: 'failed', error: reason };
      // #1759 L3 — carry the discriminator the cloud branches on; without it auth_lost re-queue never fires.
      if (extras?.failureType !== undefined) body.failureType = extras.failureType;
      if (extras?.rotatedRefreshToken !== undefined)
        body.rotatedRefreshToken = extras.rotatedRefreshToken;
      await post(scanId, body, extras?.capabilityToken);
    },

    async reportCancelled(
      scanId: string,
      toolsCompletedCount: number,
      extras?: ScanCancelledExtras,
    ): Promise<void> {
      const body: Record<string, unknown> = { status: 'cancelled', toolsCompletedCount };
      if (extras?.rotatedRefreshToken !== undefined)
        body.rotatedRefreshToken = extras.rotatedRefreshToken;
      await post(scanId, body, extras?.capabilityToken);
    },
  };
}
