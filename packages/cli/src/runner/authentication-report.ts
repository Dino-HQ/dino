/**
 * DIN-1492 — what one scan's run proved about authentication, for the terminal result.
 *
 * Per bound identity: whether authentication context was acquired in this run (a closed failure code when not), and
 * whether a later re-acquisition (after a 401) failed. Plus the final 401/403 responses the Target returned after
 * acquisition. It holds codes and counts only: no reason text, variable, token or secret. It is run-scoped; the next
 * scan acquires afresh and reports its own.
 */

import type {
  AuthenticationAcquisitionFailure,
  AuthenticationAcquisitionReport,
  AuthenticationIdentityAcquisition,
} from '@dino/core';
import type { AcquiredScanAuth, HydratedProfile } from './scan-auth';

/**
 * Dino did not release (or re-release) the identity for this run: a refused or failed hydrate, a lost refresh lease,
 * or a coalesced refresh that never yielded a fresh identity. Never `target_unreachable`: no Target request failed.
 */
export const NOT_RELEASED: AcquiredScanAuth = { authFailed: true, failure: 'identity_not_released' };

/** The RBAC role identities the scan bound beside the primary one (the hydrated token factory's bindings). */
export function boundRoleIdentities(profile: HydratedProfile): string[] {
  return (profile.tokenFactory?.bindings ?? []).map((binding) => binding.authProfileId);
}

/** A failed acquisition always reports a code; a site that set none is reported as the thrown-error default. */
function failureOf(auth: AcquiredScanAuth): AuthenticationAcquisitionFailure {
  return auth.failure ?? 'target_unreachable';
}

export type AuthenticationRecorder = {
  /** The run's first acquisition for an identity (primary or RBAC role). */
  acquisition(authProfileId: string, auth: AcquiredScanAuth): void;
  /** A re-acquisition during the run; only a failure is recorded, on an identity already acquired. */
  reacquisition(authProfileId: string, auth: AcquiredScanAuth): void;
  /** The final HTTP status of one authenticated request. */
  targetResponse(status: number): void;
  /** Every identity this scan bound; one the run never acquired is reported `not_attempted`, never omitted. */
  expect(authProfileIds: readonly string[]): void;
  report(): AuthenticationAcquisitionReport | undefined;
};

export function createAuthenticationRecorder(): AuthenticationRecorder {
  const identities = new Map<string, AuthenticationIdentityAcquisition>();
  const expected = new Set<string>();
  let unauthorized = 0;
  let forbidden = 0;
  return {
    acquisition(authProfileId, auth) {
      identities.set(
        authProfileId,
        auth.authFailed
          ? { authProfileId, outcome: 'authentication_context_not_acquired', failure: failureOf(auth) }
          : { authProfileId, outcome: 'authentication_context_acquired' },
      );
    },
    reacquisition(authProfileId, auth) {
      const current = identities.get(authProfileId);
      if (!auth.authFailed || current === undefined) return;
      identities.set(authProfileId, { ...current, reacquisitionFailure: failureOf(auth) });
    },
    targetResponse(status) {
      if (status === 401) unauthorized += 1;
      else if (status === 403) forbidden += 1;
    },
    expect(authProfileIds) {
      for (const authProfileId of authProfileIds) expected.add(authProfileId);
    },
    report() {
      if (identities.size === 0) return undefined;
      const unattempted = [...expected]
        .filter((authProfileId) => !identities.has(authProfileId))
        .map((authProfileId) => ({ authProfileId, outcome: 'authentication_context_not_attempted' as const }));
      return {
        identities: [...identities.values(), ...unattempted],
        targetRejections: { unauthorized, forbidden },
      };
    },
  };
}
