/**
 * Project Dino — RBAC Expectations Map (types and lookup only)
 *
 * Defines types and getExpectation for expected permission outcomes.
 * Tenant-specific constants (e.g. KNOWN_EXPECTATIONS, default expectations per role)
 * live in the host layer; this module exports only types and getExpectation.
 *
 * @see Issue #135 — Migrate Agents to Packages
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExpectedAccess = 'DENY' | 'ALLOW' | 'UNKNOWN';

/**
 * Auth state is a plain string to support arbitrary tenant-defined roles.
 * Some tenants use UNAUTHENTICATED/USER/CREATOR/ADMIN; another might use
 * ANONYMOUS/VIEWER/MODERATOR/OWNER.
 */
export type AuthState = string;

export type RbacExpectation = Record<string, ExpectedAccess>;

export type ExpectationsMap = Record<string, RbacExpectation>;

export type DefaultExpectationsMap = Record<string, ExpectedAccess>;

// ---------------------------------------------------------------------------
// Lookup (caller must pass expectations and defaults from host)
// ---------------------------------------------------------------------------

import { recordGet } from '@dino/core';

/**
 * Get the expected access for an operation + auth state.
 *
 * @param operationName - The GraphQL operation name
 * @param authState - The auth state (role) to check
 * @param expectations - Known expectations map (caller provides from tenant)
 * @param defaults - Default expectations per role (caller provides from tenant)
 */
export function getExpectation(
  operationName: string,
  authState: string,
  expectations: ExpectationsMap,
  defaults: DefaultExpectationsMap,
): ExpectedAccess {
  const opExpectations = recordGet(expectations, operationName);
  const result = opExpectations ? recordGet(opExpectations, authState) : undefined;
  return result ?? recordGet(defaults, authState) ?? 'UNKNOWN';
}
