/**
 * Per-role token resolution for multi-role RBAC (#1859).
 *
 * Acquisition is lazy (#2388 Task 7): constructing the resolver touches no credential. Each role's
 * profile is hydrated and its token acquired the first time `runPlannedRbacMatrix` calls
 * `tokenResolver(role, signal)`, under that lease signal, and memoised for the rest of the run.
 */

import type { AcquiredScanAuth, HydratedProfile } from './scan-auth';

export type RoleBinding = { role: string; authProfileId: string };

export type RoleTokenDeps = {
  hydrateProfile: (authProfileId: string, signal?: AbortSignal) => Promise<HydratedProfile | null>;
  acquire: (profile: HydratedProfile, profileId: string, signal?: AbortSignal) => Promise<AcquiredScanAuth>;
};

async function acquireRoleToken(
  binding: RoleBinding,
  deps: RoleTokenDeps,
  skipped: string[],
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const profile = await deps.hydrateProfile(binding.authProfileId, signal);
  const acquired = profile === null ? undefined : await deps.acquire(profile, binding.authProfileId, signal);
  if (acquired === undefined || acquired.authFailed || acquired.authToken === undefined) {
    skipped.push(binding.role);
    return null;
  }
  return acquired.authToken;
}

export async function buildRoleTokenResolver(
  bindings: ReadonlyArray<RoleBinding>,
  deps: RoleTokenDeps,
): Promise<{
  tokenResolver: (role: string, signal?: AbortSignal) => Promise<string | null>;
  /** Roles whose hydrate or acquire failed; populated as roles resolve. */
  skipped: string[];
}> {
  const bindingByRole = new Map<string, RoleBinding>();
  for (const binding of bindings) {
    if (!bindingByRole.has(binding.role)) bindingByRole.set(binding.role, binding);
  }
  const skipped: string[] = [];
  const inflight = new Map<string, Promise<string | null>>();

  return {
    tokenResolver: async (role: string, signal?: AbortSignal) => {
      if (role === 'UNAUTHENTICATED') return null;
      const binding = bindingByRole.get(role);
      if (binding === undefined) return null;
      const pending = inflight.get(role) ?? acquireRoleToken(binding, deps, skipped, signal);
      inflight.set(role, pending);
      return pending;
    },
    skipped,
  };
}
