/**
 * Runner cloud hydrate transport (F01b grant → hydrate) and the fetch cancellation seam used by scan
 * auth (#2388 Task 7: the rbac lease signal cancels grant, hydrate, and login-flow requests).
 */

import type { FetchLike } from '@dino/auth';
import type { HydratedProfile } from './scan-auth';

/** Attach a cancellation signal to a request init when one is present. */
export function withSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? init : { ...init, signal };
}

/** Bind a cancellation signal onto a fetch implementation (composed with any per-request signal). */
export function bindFetchSignal(fetchImpl: FetchLike, signal: AbortSignal | undefined): FetchLike {
  if (signal === undefined) return fetchImpl;
  return (url, init) =>
    fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

/**
 * F01b (DIN-1343): obtain a Runtime Secret Grant for a scan's profile before hydrate. Hydrate is now
 * grant-gated — the runner authorizes here (same runner auth as hydrate), the cloud pins the live
 * Credential Reference version + residency into the grant, and redemption re-validates it. Returns the
 * opaque grant token, or null on any failure (fail-closed).
 */
async function issueRuntimeSecretGrant(opts: {
  cloudEndpoint: string;
  runnerId: string;
  authProfileId: string;
  scanId: string;
  token: string;
  capabilityToken?: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}): Promise<string | null> {
  const base = opts.cloudEndpoint.replace(/\/$/, '');
  const url =
    `${base}/v1/runners/${encodeURIComponent(opts.runnerId)}` +
    `/auth-profiles/${encodeURIComponent(opts.authProfileId)}/grants`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
  };
  if (opts.capabilityToken !== undefined) {
    headers['x-dino-scan-capability'] = opts.capabilityToken;
  }
  try {
    const res = await opts.fetchImpl(
      url,
      withSignal({ method: 'POST', headers, body: JSON.stringify({ purpose: 'hydrate', scanId: opts.scanId }) }, opts.signal),
    );
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { grant?: unknown };
    return typeof body.grant === 'string' ? body.grant : null;
  } catch (err) {
    console.warn(
      JSON.stringify({
        message: 'runner_grant_issue_failed',
        detail: err instanceof Error ? err.name : 'unknown',
      }),
    );
    return null;
  }
}

export async function fetchHydratedProfile(opts: {
  cloudEndpoint: string;
  runnerId: string;
  authProfileId: string;
  scanId: string;
  token: string;
  capabilityToken?: string;
  fetchImpl: FetchLike;
  /** #2388 Task 7: cancels the grant and hydrate requests when the rbac lease ends. */
  signal?: AbortSignal;
}): Promise<HydratedProfile | null> {
  const base = opts.cloudEndpoint.replace(/\/$/, '');
  // F01b: mint a grant first; hydrate rejects (401) without `x-dino-runtime-grant`.
  const grant = await issueRuntimeSecretGrant(opts);
  if (grant === null) {
    return null;
  }
  const url =
    `${base}/v1/runners/${encodeURIComponent(opts.runnerId)}` +
    `/auth-profiles/${encodeURIComponent(opts.authProfileId)}/hydrate` +
    `?scanId=${encodeURIComponent(opts.scanId)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    'x-dino-runtime-grant': grant,
  };
  if (opts.capabilityToken !== undefined) {
    headers['x-dino-scan-capability'] = opts.capabilityToken;
  }
  try {
    const res = await opts.fetchImpl(url, withSignal({ method: 'GET', headers }, opts.signal));
    if (!res.ok) {
      return null;
    }
    const profile = (await res.json()) as HydratedProfile;
    return profile;
  } catch (err) {
    // Fail closed: a transport failure → null → caller marks auth_failed. Log the error NAME only
    // (never the body/token) for observability without leaking secrets (INV-6).
    console.warn(
      JSON.stringify({
        message: 'runner_hydrate_fetch_failed',
        detail: err instanceof Error ? err.name : 'unknown',
      }),
    );
    return null;
  }
}
