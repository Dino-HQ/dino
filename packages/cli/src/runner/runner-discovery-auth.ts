/**
 * DIN-1504 — the scan's own acquired credential, as every request of the scan presents it: the GraphQL test requests
 * (`withRunnerScanAuth`) and, since DIN-1504, discovery. One rendering, so discovery can never authenticate differently.
 */

import { scanOutcomeError, type AuthenticationAcquisitionReport, type CredentialNextAction, type RunnerJob, type RunnerResult } from '@dino/core';
import { buildExecutorRequest } from '../shared/pipeline-helpers';
import type { ReleaseRefusalCode } from './runner-hydrate';
import type { AcquiredScanAuth } from './scan-auth';

/**
 * The acquired credential in every form it can take, or nothing at all.
 *
 * #1981 — non-bearer auth (api_key / basic_auth / cookie- or header-based login_flow) is carried
 * ONLY by `injections` / `cookieHeader`. R4 threaded the bearer token but dropped these, so those
 * profiles authenticated successfully and then scanned unauthenticated — a silent false-CLEAN.
 * A failed acquisition contributes nothing (never a fabricated credential).
 */
export function acquiredCredential(
  auth: AcquiredScanAuth,
  callerToken: string | undefined,
): Partial<{ authToken: string; injections: AcquiredScanAuth['injections']; cookieHeader: string }> {
  const token = callerToken ?? (auth.authFailed ? undefined : auth.authToken);
  if (auth.authFailed) return token === undefined ? {} : { authToken: token };
  const { injections, cookieHeader } = auth;
  return {
    ...(token === undefined ? {} : { authToken: token }),
    ...(injections === undefined || injections.length === 0 ? {} : { injections }),
    ...(cookieHeader === undefined || cookieHeader === '' ? {} : { cookieHeader }),
  };
}

/**
 * DIN-1504: the scan's own acquired credential as discovery presents it — the header and cookie forms its test requests
 * carry, to the same Target. A query-injected key is NOT sent: discovery logs its endpoint URL, so a key in the URL would
 * reach logs (Codex r1). Absent for an unauthenticated scan.
 */
export type DiscoveryAuth = () => Record<string, string>;

/** The credential headers a discovery request carries, or undefined when the scan has none. */
export function discoveryAuthOf(getAuth: (() => AcquiredScanAuth) | undefined): DiscoveryAuth | undefined {
  if (getAuth === undefined) return undefined;
  return () => {
    const { injections, ...rest } = acquiredCredential(getAuth(), undefined);
    const headerInjections = injections?.filter((i) => i.target !== 'query');
    const options = headerInjections === undefined || headerInjections.length === 0 ? rest : { ...rest, injections: headerInjections };
    const { 'Content-Type': _contentType, ...credentialHeaders } = buildExecutorRequest('', options).headers;
    return credentialHeaders;
  };
}

/**
 * The discovery error as a typed outcome with a fixed classification only. The Target's own text never leaves the
 * runner — it can reflect the credential (Codex r1) — and neither does the cause.
 */
export function discoveryFailed(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/no operations/i.test(message)) return scanOutcomeError('SCAN_DISCOVERY_FAILED', 'no operations found');
  const status = /\bHTTP (\d{3})\b|\(Code: (\d{3})\)/.exec(message);
  const code = status?.[1] ?? status?.[2];
  return scanOutcomeError('SCAN_DISCOVERY_FAILED', code === undefined ? 'introspection failed' : `introspection failed (HTTP ${code})`);
}

/** The identity was not released: report the typed refusal (and its NextAction) as-is, before any Target request. */
export function refusedRunnerResult(
  assignment: RunnerJob,
  refusal: {
    credentialCode?: ReleaseRefusalCode;
    credentialNextAction?: CredentialNextAction;
    authentication?: AuthenticationAcquisitionReport;
  },
): RunnerResult {
  return {
    scanId: assignment.scanId,
    attemptId: assignment.attemptId,
    status: 'failed',
    error: 'auth_failed',
    // P1F / DIN-1502: a typed credential or Target Connection refusal is reported as-is so the scan carries an
    // honest, actionable reason instead of a generic auth failure.
    failureType: refusal.credentialCode ?? 'auth_failed',
    ...(refusal.credentialNextAction === undefined ? {} : { failureNextAction: refusal.credentialNextAction }),
    ...(refusal.authentication === undefined ? {} : { authentication: refusal.authentication }),
  };
}
