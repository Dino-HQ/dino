/**
 * Per-role token resolution for multi-role RBAC (#1859).
 */

import type { AcquiredScanAuth, HydratedProfile } from './scan-auth';

export type RoleBinding = { role: string; authProfileId: string };

export async function buildRoleTokenResolver(
  bindings: ReadonlyArray<RoleBinding>,
  deps: {
    hydrateProfile: (authProfileId: string) => Promise<HydratedProfile | null>;
    acquire: (profile: HydratedProfile, profileId: string) => Promise<AcquiredScanAuth>;
  },
): Promise<{
  tokenResolver: (role: string) => Promise<string | null>;
  skipped: string[];
}> {
  const byRole = new Map<string, string>();
  const skipped: string[] = [];

  for (const binding of bindings) {
    if (byRole.has(binding.role)) {
      continue;
    }
    const profile = await deps.hydrateProfile(binding.authProfileId);
    if (profile === null) {
      skipped.push(binding.role);
      continue;
    }
    const acquired = await deps.acquire(profile, binding.authProfileId);
    if (acquired.authFailed || acquired.authToken === undefined) {
      skipped.push(binding.role);
      continue;
    }
    byRole.set(binding.role, acquired.authToken);
  }

  return {
    tokenResolver: async (role: string) => {
      if (role === 'UNAUTHENTICATED') {
        return null;
      }
      return byRole.get(role) ?? null;
    },
    skipped,
  };
}
