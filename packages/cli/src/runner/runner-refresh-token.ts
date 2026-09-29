/**
 * The hydrated OAuth2 refresh token and the rotated-token getter the scan reports (extracted from
 * runner-scan-auth-wiring.ts).
 */

import type { HydratedProfile } from './scan-auth';

export function readHydratedRefreshToken(profile: HydratedProfile): string | undefined {
  if (profile.credential === null || profile.credential.trim() === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(profile.credential);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const rt = parsed.refresh_token;
    if (typeof rt === 'string' && rt.trim() !== '') {
      return rt;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function buildRotatedRefreshGetter(
  originalHydratedRefreshToken: string | undefined,
  readCurrentRefreshToken: () => string | undefined,
): () => string | undefined {
  return () => {
    const currentRefreshToken = readCurrentRefreshToken();
    if (currentRefreshToken === undefined || currentRefreshToken === '') {
      return undefined;
    }
    if (
      originalHydratedRefreshToken !== undefined &&
      currentRefreshToken === originalHydratedRefreshToken
    ) {
      return undefined;
    }
    return currentRefreshToken;
  };
}
