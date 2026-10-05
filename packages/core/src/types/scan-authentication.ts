/**
 * DIN-1492 — the run-scoped authentication outcome of one scan attempt.
 *
 * The runner acquires authentication context afresh at the start of every scan, through the exact Target Connection,
 * Authentication Flow and Credential Reference versions the scan was admitted with. It reports only what happened in
 * that run: context acquired or not (with a closed failure code), and how many requests the Target then rejected
 * (401) or did not authorize (403). None of this is credential health, Target health, a verification result or a
 * finding, and no prior acquisition is ever treated as readiness for a later run.
 */

import { z } from 'zod';

export const AUTHENTICATION_ACQUISITION_OUTCOMES = [
  'authentication_context_acquired',
  'authentication_context_not_acquired',
  /** A bound identity this run never needed (an RBAC role the run did not exercise). */
  'authentication_context_not_attempted',
] as const;
export type AuthenticationAcquisitionOutcome = (typeof AUTHENTICATION_ACQUISITION_OUTCOMES)[number];

/** Why authentication context was not acquired. Closed: raw runner reasons never leave the runner. */
export const AUTHENTICATION_ACQUISITION_FAILURES = [
  'target_rejected_login',
  'target_login_error',
  'destination_refused',
  'login_response_unusable',
  'otp_unavailable',
  'secret_unavailable',
  'flow_invalid',
  'target_unreachable',
  /** Dino did not release the identity for this run (its hydrate was refused or failed). */
  'identity_not_released',
] as const;
export type AuthenticationAcquisitionFailure = (typeof AUTHENTICATION_ACQUISITION_FAILURES)[number];

/** Upper bound on counted Target rejections; a runner never reports more than one scan's requests. */
export const AUTHENTICATION_REJECTION_COUNT_MAX = 10_000_000;

/** One bound Authentication Identity's acquisition in this run, as the runner reports it. */
export type AuthenticationIdentityAcquisition = {
  readonly authProfileId: string;
  readonly outcome: AuthenticationAcquisitionOutcome;
  /** Set exactly when the outcome is `authentication_context_not_acquired`. */
  readonly failure?: AuthenticationAcquisitionFailure;
  /** Only after `authentication_context_acquired`: a mid-run re-acquisition (after a 401) that failed. */
  readonly reacquisitionFailure?: AuthenticationAcquisitionFailure;
};

/** Final responses the Target returned after context was acquired. */
export type AuthenticationTargetRejections = {
  /** 401 after the one re-acquisition the runner makes. */
  readonly unauthorized: number;
  /** 403: the Target did not authorize the request. */
  readonly forbidden: number;
};

/** The runner's report on a terminal scan result. It names no versions: the cloud owns those facts. */
export type AuthenticationAcquisitionReport = {
  readonly identities: readonly AuthenticationIdentityAcquisition[];
  readonly targetRejections: AuthenticationTargetRejections;
};

export const AUTHENTICATION_RUN_SCOPE_STATEMENT =
  'Authentication context is reported for this run only. It is not credential health, Target health or a verification result.';

export const AUTHENTICATION_TARGET_REJECTIONS_STATEMENT =
  'The Target rejected (401) or did not authorize (403) these requests in this run. This is not credential health and not a finding.';

/** One identity in the view, with the versions the scan was admitted with. */
export type ScanAuthenticationIdentityView = {
  readonly authProfileId: string;
  /** `not_reported`: the scan bound this identity but the run's report did not name it (never read as acquired). */
  readonly outcome: AuthenticationAcquisitionOutcome | 'not_reported';
  readonly failure: AuthenticationAcquisitionFailure | null;
  readonly reacquisitionFailure: AuthenticationAcquisitionFailure | null;
  /** The Authentication Flow version the Connection pinned; null for an identity that runs no flow. */
  readonly flow: {
    readonly versionId: string;
    readonly version: number;
    readonly flowDigest: string;
  } | null;
  /** The Credential Reference version the scan pinned; null for an identity that stores no credential. */
  readonly credentialReference: {
    readonly referenceId: string;
    readonly version: number;
  } | null;
};

/**
 * One attempt's authentication, as HTTP (`GET /v1/scans/:id/attempts`) and MCP (`get_scan_authentication`) return it.
 * `null` on an attempt means nothing was reported; it is never read as acquired.
 */
export type ScanAuthenticationView =
  | {
      readonly kind: 'reported';
      readonly scope: 'run';
      readonly statement: typeof AUTHENTICATION_RUN_SCOPE_STATEMENT;
      readonly connection: {
        readonly versionId: string;
        readonly version: number;
      } | null;
      readonly identities: readonly ScanAuthenticationIdentityView[];
      readonly targetRejections: AuthenticationTargetRejections & {
        readonly statement: typeof AUTHENTICATION_TARGET_REJECTIONS_STATEMENT;
      };
    }
  | {
      /** Authority was refused before any acquisition was attempted (e.g. the Connection went stale). */
      readonly kind: 'not_attempted';
      readonly scope: 'run';
      readonly statement: typeof AUTHENTICATION_RUN_SCOPE_STATEMENT;
      readonly refusal: string;
    };

/** MCP `get_scan_authentication`: the authentication of every attempt of one scan. */
export const ScanAuthenticationRefSchema = z
  .object({ scanId: z.string().trim().min(1).max(128) })
  .strict();

/** DIN-1506: why a failed attempt failed — a stable code, the runner's redacted message, and a bounded NextAction. */
export type ScanAttemptFailureView = {
  readonly code: string;
  readonly detail: string | null;
  readonly nextAction: { readonly kind: string; readonly reasonCode: string } | null;
};

export type ScanAuthenticationAttemptView = {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly authentication: ScanAuthenticationView | null;
  /** Null unless the attempt failed. */
  readonly failure: ScanAttemptFailureView | null;
};

export type ScanAuthenticationListView = {
  readonly scanId: string;
  readonly currentAttemptId: string | null;
  readonly attempts: readonly ScanAuthenticationAttemptView[];
};
