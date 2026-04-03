/**
 * Project Dino — Fuzz Input Strategies
 *
 * Five fuzz input generators that produce intentionally invalid inputs
 * to test API robustness. Each strategy targets a different class of
 * input validation failure.
 *
 * Strategies:
 * 1. Type confusion — string/int/boolean swaps for every field type
 * 2. Oversized inputs — 10K strings, 100-element arrays
 * 3. Depth attacks — 15+ levels of nested objects
 * 4. Null injection — null for every required field
 * 5. Special characters — SQL injection, NoSQL operators, XSS payloads
 *
 * @see Issue #7 — Input Fuzzing
 */

import { recordGet } from '@dino/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FuzzStrategyName =
  | 'TYPE_CONFUSION'
  | 'OVERSIZED'
  | 'DEPTH_ATTACK'
  | 'NULL_INJECTION'
  | 'SPECIAL_CHARS';

export interface FuzzInput {
  /** Human-readable label for this fuzz case. */
  label: string;
  /** The strategy that generated this input. */
  strategy: FuzzStrategyName;
  /** The fuzzed variable values to send with the operation. */
  variables: Record<string, unknown>;
}

export interface ArgInfo {
  name: string;
  type: string;
  isRequired: boolean;
}

export interface FuzzStrategyOptions {
  /** Depth levels for DEPTH_ATTACK strategy. Default: [15, 30]. Max: 50. */
  depthAttackLevels?: number[];
}

/** Quick-mode strategies (for PR gates, <2 min). */
export const QUICK_STRATEGIES: readonly FuzzStrategyName[] = [
  'TYPE_CONFUSION',
  'NULL_INJECTION',
] as const;

/** All strategies (for nightly full runs). */
export const ALL_STRATEGIES: readonly FuzzStrategyName[] = [
  'TYPE_CONFUSION',
  'OVERSIZED',
  'DEPTH_ATTACK',
  'NULL_INJECTION',
  'SPECIAL_CHARS',
] as const;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Strip GraphQL wrapper characters (!, [, ]) to get base type name. */
function stripTypeWrappers(typeString: string): string {
  return typeString.replaceAll(/[![\]]/g, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Strategy 1: Type confusion
// ---------------------------------------------------------------------------

/** Map expected type to wrong-type values. */
const TYPE_SWAPS: Record<string, unknown[]> = {
  string: [42, true, [], {}],
  int: ['not-a-number', true, [], {}],
  float: ['not-a-float', true, [], {}],
  boolean: ['not-a-bool', 42, [], {}],
  id: [42, true, [], {}],
};

function generateTypeConfusion(args: ArgInfo[]): FuzzInput[] {
  const results: FuzzInput[] = [];

  for (const arg of args) {
    const baseType = stripTypeWrappers(arg.type);
    const swaps = recordGet(TYPE_SWAPS, baseType) ?? recordGet(TYPE_SWAPS, 'string') ?? [];

    for (const wrongValue of swaps) {
      results.push({
        label: `type-confusion: ${arg.name} expects ${arg.type}, got ${typeof wrongValue}(${JSON.stringify(wrongValue)})`,
        strategy: 'TYPE_CONFUSION',
        variables: { [arg.name]: wrongValue },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 2: Oversized inputs
// ---------------------------------------------------------------------------

/** Deterministic oversized test payloads (immutable constants, not request-scoped). */
const OVERSIZED_STRING = 'A'.repeat(10_000);
const OVERSIZED_ARRAY: readonly string[] = Object.freeze(
  Array.from({ length: 100 }, (_, i) => `item-${i}`),
);

function generateOversized(args: ArgInfo[]): FuzzInput[] {
  const results: FuzzInput[] = [];

  for (const arg of args) {
    const baseType = stripTypeWrappers(arg.type);
    const isList = arg.type.includes('[');

    if (isList) {
      results.push({
        label: `oversized: ${arg.name} with 100-element array`,
        strategy: 'OVERSIZED',
        variables: { [arg.name]: [...OVERSIZED_ARRAY] },
      });
    }

    if (baseType === 'string' || baseType === 'id') {
      results.push({
        label: `oversized: ${arg.name} with 10K string`,
        strategy: 'OVERSIZED',
        variables: { [arg.name]: OVERSIZED_STRING },
      });
    }

    // Always try an oversized object for complex types
    const SCALAR_TYPES = new Set(['string', 'int', 'float', 'boolean', 'id']);
    if (!SCALAR_TYPES.has(baseType)) {
      const bigObj: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        bigObj[`field_${i}`] = OVERSIZED_STRING.slice(0, 200);
      }
      results.push({
        label: `oversized: ${arg.name} with 50-field object`,
        strategy: 'OVERSIZED',
        variables: { [arg.name]: bigObj },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 3: Depth attacks
// ---------------------------------------------------------------------------

function buildNestedObject(depth: number): Record<string, unknown> {
  if (depth <= 0) return { leaf: 'value' };
  return { nested: buildNestedObject(depth - 1) };
}

const DEFAULT_DEPTH_LEVELS = [15, 30];
const MAX_DEPTH_LEVEL = 50;

function generateDepthAttack(args: ArgInfo[], levels: number[]): FuzzInput[] {
  const results: FuzzInput[] = [];

  for (const arg of args) {
    for (const rawLevel of levels) {
      const level = Math.min(Math.max(rawLevel, 0), MAX_DEPTH_LEVEL);
      results.push({
        label: `depth-attack: ${arg.name} with ${level} nested levels`,
        strategy: 'DEPTH_ATTACK',
        variables: { [arg.name]: buildNestedObject(level) },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 4: Null injection
// ---------------------------------------------------------------------------

function generateNullInjection(args: ArgInfo[]): FuzzInput[] {
  const results: FuzzInput[] = [];

  // Individual null per required field
  for (const arg of args) {
    if (arg.isRequired) {
      results.push({
        label: `null-injection: ${arg.name} (required) set to null`,
        strategy: 'NULL_INJECTION',
        variables: { [arg.name]: null },
      });
    }
  }

  // All args null at once
  if (args.length > 0) {
    const allNull: Record<string, null> = {};
    for (const arg of args) {
      allNull[arg.name] = null;
    }
    results.push({
      label: 'null-injection: all arguments set to null',
      strategy: 'NULL_INJECTION',
      variables: allNull,
    });
  }

  // Undefined / missing (empty object)
  if (args.some((a) => a.isRequired)) {
    results.push({
      label: 'null-injection: empty variables (all required args missing)',
      strategy: 'NULL_INJECTION',
      variables: {},
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 5: Special characters
// ---------------------------------------------------------------------------

const SPECIAL_CHAR_PAYLOADS: Array<{ label: string; value: string }> = [
  // SQL injection
  { label: 'sql-injection-basic', value: "'; DROP TABLE users; --" },
  { label: 'sql-injection-union', value: "' UNION SELECT * FROM users --" },
  { label: 'sql-injection-or', value: "' OR '1'='1" },

  // NoSQL operators (MongoDB)
  { label: 'nosql-gt-operator', value: '{"$gt":""}' },
  { label: 'nosql-regex-operator', value: '{"$regex":".*"}' },
  { label: 'nosql-where-operator', value: '{"$where":"return true"}' },

  // XSS payloads
  { label: 'xss-script-tag', value: '<script>alert("xss")</script>' },
  { label: 'xss-img-onerror', value: '<img src=x onerror=alert("xss")>' },
  { label: 'xss-event-handler', value: '" onmouseover="alert(1)' },

  // Path traversal
  { label: 'path-traversal', value: '../../../etc/passwd' },

  // Null bytes
  { label: 'null-byte', value: 'test\x00injected' },
];

/** NoSQL operator objects (sent as object values, not strings). */
const NOSQL_OBJECT_PAYLOADS: Array<{ label: string; value: unknown }> = [
  { label: 'nosql-obj-gt', value: { $gt: '' } },
  { label: 'nosql-obj-regex', value: { $regex: '.*' } },
  { label: 'nosql-obj-ne', value: { $ne: null } },
];

function generateSpecialChars(args: ArgInfo[]): FuzzInput[] {
  const results: FuzzInput[] = [];

  for (const arg of args) {
    // String payloads
    for (const payload of SPECIAL_CHAR_PAYLOADS) {
      results.push({
        label: `special-chars: ${arg.name} <- ${payload.label}`,
        strategy: 'SPECIAL_CHARS',
        variables: { [arg.name]: payload.value },
      });
    }

    // NoSQL object payloads (for fields that might be used in DB queries)
    for (const payload of NOSQL_OBJECT_PAYLOADS) {
      results.push({
        label: `special-chars: ${arg.name} <- ${payload.label}`,
        strategy: 'SPECIAL_CHARS',
        variables: { [arg.name]: payload.value },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy dispatcher
// ---------------------------------------------------------------------------

/** Generate fuzz inputs for a given strategy and argument list. */
export function generateFuzzInputs(
  strategy: FuzzStrategyName,
  args: ArgInfo[],
  options?: FuzzStrategyOptions,
): FuzzInput[] {
  if (args.length === 0) return [];

  const depthLevels = options?.depthAttackLevels ?? DEFAULT_DEPTH_LEVELS;

  switch (strategy) {
    case 'TYPE_CONFUSION':
      return generateTypeConfusion(args);
    case 'OVERSIZED':
      return generateOversized(args);
    case 'DEPTH_ATTACK':
      return generateDepthAttack(args, depthLevels);
    case 'NULL_INJECTION':
      return generateNullInjection(args);
    case 'SPECIAL_CHARS':
      return generateSpecialChars(args);
    default:
      return [];
  }
}
