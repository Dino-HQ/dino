/**
 * Runner–cloud contract types.
 *
 * These are the canonical shapes for communication between the scan runner
 * (CLI daemon) and the cloud backend. Both sides import from here — no
 * duplicated DTOs.
 *
 * TypeBox validation schemas in @dino/cloud mirror these shapes for runtime
 * validation at the HTTP boundary. The types here are the compile-time
 * contract; the schemas are the runtime enforcement.
 */

import type { ScanId, TenantId } from './ids';
import type { SentinelScanCommand } from './sentinel.js';

/**
 * A scan assignment sent from cloud to runner.
 *
 * Returned by `GET /v1/runners/:id/assignments` (200 body).
 * Runner polls this endpoint to discover work.
 */
export interface RunnerJob {
  scanId: ScanId;
  tenantId: TenantId;
  targetUrl: string;
  /** Sentinel decision-engine scan plan (#1388). Omitted for manual/legacy scans. */
  command?: SentinelScanCommand;
  /** Linked auth profile for scan-time credential acquisition (#1759 B3b). */
  authProfileId?: string;
  /** Per-scan capability for pool runners (#68); required for hydrate + /otp on pool identity. */
  capabilityToken?: string;
}

/**
 * Serialized Sigstore attestation emitted by the pipeline (#1154).
 *
 * Shape matches `@dino/engine` AttestationBundle — duplicated here so `@dino/core`
 * stays dependency-light for runner/cloud contracts.
 */
export interface ScanAttestationWire {
  bundle: string;
  resultDigest: string;
  signedAt: string;
}

/**
 * A scan result sent from runner to cloud.
 *
 * Posted to `POST /v1/scans/:id/results` (runner-auth).
 * The scanId is in the URL path, not the body — included here for
 * internal routing after the HTTP layer extracts it.
 *
 * Discriminated union: completed results MUST have dcg, failed results
 * MUST have error. { status: 'completed' } with no dcg is a compile error.
 */
export type RunnerResult =
  | {
      scanId: ScanId;
      status: 'completed';
      dcg: unknown;
      /**
       * Cryptographic attestation for `dcg` when the pipeline had `attestationSigner` configured.
       * Omitted when signing skipped or failed (INV-1 — scan still completes).
       */
      attestation?: ScanAttestationWire | undefined;
      /** Full pipeline JSON for dashboard materialization (#1234). Optional for older runners. */
      result?: unknown;
      /** Rotated OAuth2 refresh_token to persist across scans (#1759 #30). */
      rotatedRefreshToken?: string | undefined;
    }
  | {
      scanId: ScanId;
      status: 'failed';
      error: string;
      failureType?: string | undefined;
      /** Rotated OAuth2 refresh_token to persist across scans (#1759 #30). */
      rotatedRefreshToken?: string | undefined;
    }
  | {
      scanId: ScanId;
      /**
       * Terminal cancel (live-scan-logs Spec B): reported ONLY after the cloud's cancelRequested
       * flag was observed AND the pipeline abort path ran (Spec B INV-4 — never fabricated).
       */
      status: 'cancelled';
      /** Tools that completed before the abort — 0 suppresses pool metering (Spec B INV-5). */
      toolsCompletedCount: number;
      /** Rotated OAuth2 refresh_token to persist across scans (#1759 #30). */
      rotatedRefreshToken?: string | undefined;
    };
