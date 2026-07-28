/**
 * #1759 #37 — Runner client for OAuth2 refresh lease acquire/release.
 */

import type { FetchLike } from '@dino/auth';

export type RefreshLeaseAcquireResult =
  | { ok: true; acquired: true; leaseUntil?: number }
  | { ok: true; acquired: false }
  | { ok: false; reason: string };

export type OAuth2RefreshLeaseClient = {
  acquire(opts?: { leaseDurationMs?: number }): Promise<RefreshLeaseAcquireResult>;
  release(): Promise<void>;
};

export function isOAuth2RefreshLeaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OAUTH2_REFRESH_LEASE_ENABLED === 'true';
}

function leaseAuthHeaders(token: string, capabilityToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (capabilityToken !== undefined) {
    headers['x-dino-scan-capability'] = capabilityToken;
  }
  return headers;
}

function parseAcquireResponse(body: unknown): RefreshLeaseAcquireResult | null {
  if (typeof body !== 'object' || body === null || !('acquired' in body)) {
    return null;
  }
  const acquired = body.acquired;
  if (typeof acquired !== 'boolean') {
    return null;
  }
  if (!acquired) {
    return { ok: true, acquired: false };
  }
  const leaseUntil =
    'leaseUntil' in body && typeof body.leaseUntil === 'number' ? body.leaseUntil : undefined;
  return {
    ok: true,
    acquired: true,
    ...(leaseUntil === undefined ? {} : { leaseUntil }),
  };
}

export function createOAuth2RefreshLeaseClient(opts: {
  cloudEndpoint: string;
  runnerId: string;
  profileId: string;
  scanId: string;
  token: string;
  capabilityToken?: string;
  fetchImpl: FetchLike;
}): OAuth2RefreshLeaseClient {
  const base = opts.cloudEndpoint.replace(/\/$/, '');
  const acquireUrl =
    `${base}/v1/runners/${encodeURIComponent(opts.runnerId)}` +
    `/auth-profiles/${encodeURIComponent(opts.profileId)}/refresh-lease`;
  const releaseUrl = `${acquireUrl}/release`;

  return {
    async acquire(acquireOpts) {
      try {
        const res = await opts.fetchImpl(acquireUrl, {
          method: 'POST',
          headers: leaseAuthHeaders(opts.token, opts.capabilityToken),
          body: JSON.stringify({
            scanId: opts.scanId,
            ...(acquireOpts?.leaseDurationMs === undefined
              ? {}
              : { leaseDurationMs: acquireOpts.leaseDurationMs }),
          }),
        });
        if (!res.ok) {
          return { ok: false, reason: `http_${res.status}` };
        }
        const parsed = parseAcquireResponse(await res.json());
        return parsed ?? { ok: false, reason: 'invalid_response' };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.name : 'fetch_failed' };
      }
    },
    async release() {
      try {
        await opts.fetchImpl(releaseUrl, {
          method: 'POST',
          headers: leaseAuthHeaders(opts.token, opts.capabilityToken),
          body: JSON.stringify({ scanId: opts.scanId }),
        });
      } catch (err) {
        console.info(
          JSON.stringify({
            message: 'oauth2_refresh_lease_release_failed',
            reason: err instanceof Error ? err.name : 'unknown',
          }),
        );
      }
    },
  };
}
