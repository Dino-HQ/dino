/**
 * Dashboard member roles and fine-grained Dino permissions (Issue #1276).
 *
 * Roles are stored in `member_profiles.role` and never overwritten from Stytch
 * after the first projection row exists — see member-sync in @dino/cloud.
 *
 * Ownership convention for resource rows (`created_by_member_id`, etc.) is
 * planned for #1277 — this module defines only role → permission mapping.
 */

export const MEMBER_ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

function rankOf(role: MemberRole): number {
  switch (role) {
    case 'owner':
      return 0;
    case 'admin':
      return 1;
    case 'developer':
      return 2;
    case 'viewer':
      return 3;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/** Ordered by authority: owner (0) > admin (1) > developer (2) > viewer (3). */
export const ROLE_HIERARCHY: Record<MemberRole, number> = {
  owner: rankOf('owner'),
  admin: rankOf('admin'),
  developer: rankOf('developer'),
  viewer: rankOf('viewer'),
};

/** Human-friendly display labels for each role (single source of truth — console reads these). */
export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  developer: 'Developer',
  viewer: 'Viewer',
};

/**
 * Whether a role is offered in the invite / change-role dropdowns. `owner` is transferred,
 * not assigned, so it is never a dropdown option. NOTE: this is a DISPLAY hint only — the
 * actual invite/change-role authorization is enforced server-side on the request, never by
 * trusting the catalog.
 */
export const ROLE_ASSIGNABLE: Record<MemberRole, boolean> = {
  owner: false,
  admin: true,
  developer: true,
  viewer: true,
};

/** One entry in the console-facing role catalog (`GET /v1/tenants/:id/roles`). */
export interface MemberRoleCatalogEntry {
  readonly key: MemberRole;
  readonly label: string;
  /** Authority rank from ROLE_HIERARCHY — 0 = highest. Sort ascending for highest-first. */
  readonly rank: number;
  readonly assignable: boolean;
}

/**
 * The role catalog the console renders (labels + de-hardcoded dropdowns). An explicit literal
 * (no computed index access). `member-role-catalog.*.test.ts` pins every entry against
 * MEMBER_ROLES / ROLE_LABELS / ROLE_HIERARCHY / ROLE_ASSIGNABLE so it can never drift.
 */
export const MEMBER_ROLE_CATALOG: readonly MemberRoleCatalogEntry[] = [
  { key: 'owner', label: 'Owner', rank: 0, assignable: false },
  { key: 'admin', label: 'Admin', rank: 1, assignable: true },
  { key: 'developer', label: 'Developer', rank: 2, assignable: true },
  { key: 'viewer', label: 'Viewer', rank: 3, assignable: true },
];

export const DINO_PERMISSIONS = [
  'api:create',
  'api:update',
  'api:delete',
  'scan:trigger',
  'scan:retry',
  'scan:cancel',
  'settings:update',
  'settings:read',
  'settings:ai:update',
  'settings:ai:delete',
  'sentinel:configure',
  'sentinel:acknowledge',
  'sentinel:dismiss',
  'sentinel:snooze',
  'sentinel:feedback',
  'member:remove',
  'member:invite',
  'member:role_change',
  'member:mfa_reset',
  'runner:register',
  'runner:managed:create',
  'runner:managed:control',
  'runner:managed:delete',
  'runner:oidc:update',
  'finding:share',
  'intelligence:query',
  'test_connection:trigger',
  'sentinel:configure:elevated',
] as const;
export type DinoPermission = (typeof DINO_PERMISSIONS)[number];

const OWNER_ONLY: readonly DinoPermission[] = [
  'api:delete',
  'member:remove',
  'member:role_change',
  'runner:managed:delete',
  'sentinel:configure:elevated',
];

const ADMIN_PLUS: readonly DinoPermission[] = [
  'api:create',
  'api:update',
  'scan:trigger',
  'scan:retry',
  'scan:cancel',
  'settings:update',
  'settings:read',
  'settings:ai:update',
  'settings:ai:delete',
  'sentinel:configure',
  'sentinel:acknowledge',
  'sentinel:dismiss',
  'sentinel:snooze',
  'sentinel:feedback',
  'runner:register',
  'runner:managed:create',
  'runner:managed:control',
  'runner:oidc:update',
  'finding:share',
  'intelligence:query',
  'test_connection:trigger',
  'member:invite',
  // Locked-out-teammate recovery: reset (fully remove) another member's MFA enrollment. Admin+,
  // not owner-only — the recovery scenario is exactly when the owner may be unavailable.
  'member:mfa_reset',
];

const DEVELOPER_PERMS: readonly DinoPermission[] = [
  'scan:trigger',
  'scan:retry',
  'scan:cancel',
  'settings:read',
  'sentinel:acknowledge',
  'sentinel:dismiss',
  'sentinel:snooze',
  'sentinel:feedback',
  'finding:share',
  'intelligence:query',
  'test_connection:trigger',
];

function permissionsForRole(role: MemberRole): readonly DinoPermission[] {
  switch (role) {
    case 'owner':
      return [...ADMIN_PLUS, ...OWNER_ONLY];
    case 'admin':
      return ADMIN_PLUS;
    case 'developer':
      return DEVELOPER_PERMS;
    case 'viewer':
      return ['settings:read'];
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/** Maps each role to the permissions it grants. */
export const ROLE_PERMISSIONS: Record<MemberRole, readonly DinoPermission[]> = {
  owner: permissionsForRole('owner'),
  admin: permissionsForRole('admin'),
  developer: permissionsForRole('developer'),
  viewer: permissionsForRole('viewer'),
};

export function hasPermission(role: MemberRole, permission: DinoPermission): boolean {
  return permissionsForRole(role).includes(permission);
}

/** True if `actual` is at least as privileged as `required` in the hierarchy. */
export function meetsMinimumRole(actual: MemberRole, required: MemberRole): boolean {
  return rankOf(actual) <= rankOf(required);
}

/** Effective permission strings for API surfaces (e.g. GET /me). */
export function effectivePermissionsForRole(role: MemberRole): DinoPermission[] {
  return DINO_PERMISSIONS.filter((p) => hasPermission(role, p));
}
