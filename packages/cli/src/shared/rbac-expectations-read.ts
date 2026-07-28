/**
 * RBAC expectation reader — lean module for scan assembly + Hegel invariants (#1857).
 * Kept separate from scan-helpers.ts to avoid pulling @dino/engine/Ink into Hegel child processes.
 */

import { recordSet } from '@dino/core';
import { CliError } from './errors';
import type { CommandContext } from './base-command';
import type { DefaultExpectationsMap, ExpectedAccess, ExpectationsMap } from '@dino/agents';

const RBAC_EXPECTED_ACCESS = ['ALLOW', 'DENY', 'UNKNOWN'] as const;

// Compile-time proof the runtime allowlist covers every ExpectedAccess arm.
const _accessCoverage: Record<ExpectedAccess, true> = { ALLOW: true, DENY: true, UNKNOWN: true };
if (_accessCoverage.ALLOW !== true) {
  throw new Error('unreachable');
}

function assertExpectedAccessValue(value: unknown, label: string): asserts value is ExpectedAccess {
  if (typeof value !== 'string') {
    throw new CliError(`Invalid RBAC expectation for ${label}: value must be a string`);
  }
  if (!(RBAC_EXPECTED_ACCESS as readonly string[]).includes(value)) {
    throw new CliError(
      `Invalid RBAC expectation for ${label}: "${value}" must be one of ALLOW, DENY, UNKNOWN`,
    );
  }
}

/**
 * Fail-closed structural guard. A non-object map (number/bool/array/null) would otherwise
 * coerce under Object.entries to a silent empty map → the authored operation vanishes to
 * UNKNOWN/inconclusive instead of erroring. The validator must reject malformed structure on
 * its OWN contract — it cannot assume an upstream zod load (the Spec-2 managed-runner path
 * builds expectations from hydrated JSON that may not pass through tenant-loader).
 */
function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(
      `Invalid RBAC expectation for ${label}: expected an object of role → access`,
    );
  }
}

function validateExpectationsMap(raw: unknown): ExpectationsMap {
  assertPlainObject(raw, 'expectations');
  const out: ExpectationsMap = {};
  for (const [operation, roleMap] of Object.entries(raw)) {
    assertPlainObject(roleMap, `operation "${operation}"`);
    const validated: Record<string, ExpectedAccess> = {};
    for (const [role, value] of Object.entries(roleMap)) {
      assertExpectedAccessValue(value, `operation "${operation}" role "${role}"`);
      recordSet(validated, role, value);
    }
    recordSet(out, operation, validated);
  }
  return out;
}

function validateDefaultExpectationsMap(raw: unknown): DefaultExpectationsMap {
  assertPlainObject(raw, 'defaults');
  const out: DefaultExpectationsMap = {};
  for (const [role, value] of Object.entries(raw)) {
    assertExpectedAccessValue(value, `default role "${role}"`);
    recordSet(out, role, value);
  }
  return out;
}

/** Fail-closed validation for hydrated or tenant-config RBAC expectation JSON (#1857, #1859). */
export function validateRbacExpectations(raw: { expectations?: unknown; defaults?: unknown }): {
  expectations?: ExpectationsMap;
  defaultExpectations?: DefaultExpectationsMap;
} {
  return {
    ...(raw.expectations === undefined
      ? {}
      : { expectations: validateExpectationsMap(raw.expectations) }),
    ...(raw.defaults === undefined
      ? {}
      : { defaultExpectations: validateDefaultExpectationsMap(raw.defaults) }),
  };
}

/** Read and validate RBAC expectation maps from tenant config (INV-1). */
export function readRbacExpectationsFromContext(context: CommandContext): {
  expectations?: ExpectationsMap;
  defaultExpectations?: DefaultExpectationsMap;
} {
  const rbac = context.tenantConfig.rbac;
  if (!rbac) {
    return {};
  }

  return validateRbacExpectations({
    expectations: rbac.expectations,
    defaults: rbac.defaults,
  });
}
