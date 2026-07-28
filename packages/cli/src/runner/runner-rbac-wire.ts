/**
 * Multi-role RBAC wire helpers (#1859).
 */

import { buildRoleTokenResolver } from './runner-role-token-resolver';
import { validateRbacExpectations } from '../shared/rbac-expectations-read';
import type { AcquiredScanAuth, HydratedProfile } from './scan-auth';
import type { DefaultExpectationsMap, ExpectationsMap } from '@dino/agents';

export type RunnerRbacWire = {
  rbacRoles: string[];
  rbacExpectations?: ExpectationsMap;
  rbacDefaultExpectations?: DefaultExpectationsMap;
  tokenResolver: (role: string) => Promise<string | null>;
  skippedRoles: string[];
};

function parseRolesJson(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((role) => typeof role === 'string')) {
    throw new Error('invalid rolesJson');
  }
  return parsed;
}

/** True when the hydrated profile carries multi-role RBAC bindings + roles (fail-closed gate for #1871). */
export function hydratedProfileDeclaresRbac(profile: HydratedProfile): boolean {
  const tf = profile.tokenFactory;
  if (tf === undefined || tf === null) {
    return false;
  }
  if ((tf.bindings ?? []).length === 0) {
    return false;
  }
  const raw = tf.rolesJson;
  if (raw === null || raw === undefined || raw.trim() === '') {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return true;
  }
}

function parseHydratedRbacJson(raw: string | null | undefined): {
  expectations?: unknown;
  defaults?: unknown;
} {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid rbacExpectationsJson');
  }
  const record = parsed as Record<string, unknown>;
  if ('expectations' in record || 'defaults' in record) {
    return { expectations: record.expectations, defaults: record.defaults };
  }
  return { expectations: parsed };
}

export async function wireMultiRoleRbac(
  hydratedProfile: HydratedProfile,
  deps: {
    hydrateProfile: (authProfileId: string) => Promise<HydratedProfile | null>;
    acquire: (profile: HydratedProfile, profileId: string) => Promise<AcquiredScanAuth>;
  },
): Promise<RunnerRbacWire | undefined> {
  const bindings = hydratedProfile.tokenFactory?.bindings ?? [];
  if (bindings.length === 0) {
    return undefined;
  }

  const rbacRoles = parseRolesJson(hydratedProfile.tokenFactory?.rolesJson);
  if (rbacRoles.length === 0) {
    return undefined;
  }

  const validated = validateRbacExpectations(
    parseHydratedRbacJson(hydratedProfile.tokenFactory?.rbacExpectationsJson),
  );

  const { tokenResolver, skipped } = await buildRoleTokenResolver(bindings, {
    hydrateProfile: deps.hydrateProfile,
    acquire: (profile, authProfileId) => deps.acquire(profile, authProfileId),
  });

  return {
    rbacRoles,
    ...(validated.expectations === undefined ? {} : { rbacExpectations: validated.expectations }),
    ...(validated.defaultExpectations === undefined
      ? {}
      : { rbacDefaultExpectations: validated.defaultExpectations }),
    tokenResolver,
    skippedRoles: skipped,
  };
}
