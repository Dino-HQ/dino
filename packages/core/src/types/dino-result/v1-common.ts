// packages/core/src/types/dino-result/v1-common.ts
import { Type } from '@sinclair/typebox';
import {
  NOT_TESTED_REASONS,
  VERIFICATION_UNITS,
  type EnvelopeSeverityLevel,
  type SeverityLevel,
} from '../result-envelope';

/** Runtime literal sources for the type aliases the sealed envelope kernel exports (spec §4.1, review M‑2). */
export const DINO_SEVERITY_LEVELS = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const) satisfies readonly SeverityLevel[];
export const DINO_ENVELOPE_LEVELS = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'CLEAN', 'UNTESTED'] as const) satisfies readonly EnvelopeSeverityLevel[];
/** The seven verification tools, frozen at runtime (Codex review). `@dino/engine`'s `ToolName` is checked against this list at compile time. */
export const DINO_TOOL_NAMES = Object.freeze([
  'input-fuzzer',
  'response-validator',
  'rbac-matrix',
  'rate-limit-validator',
  'error-code-validator',
  'deprecation-tracker',
  'rest-fuzzer',
] as const);
export type DinoToolName = (typeof DINO_TOOL_NAMES)[number];

/** A union of string literals whose static type is `T[number]` (TypeBox's sanctioned typing seam). */
export function literals<const T extends readonly string[]>(values: T) {
  return Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));
}

export const ToolNameSchema = literals(DINO_TOOL_NAMES);
export const SeverityLevelSchema = literals(DINO_SEVERITY_LEVELS);
export const EnvelopeLevelSchema = literals(DINO_ENVELOPE_LEVELS);
export const ProtocolSchema = literals(['graphql', 'rest'] as const);
export const NonNegativeInt = Type.Integer({ minimum: 0 });
/** RFC 3339 UTC instant as `Date.prototype.toISOString` emits it. */
export const IsoInstant = Type.String({
  pattern: String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$`,
});
/**
 * Every digest a `DinoResult 1.0` carries: lowercase hex SHA-256 over `canonical.ts` bytes (`dinoResultDigest`).
 * Changing the algorithm or the canonical form is a `dinoResult` version bump, never a reinterpretation (spec-scope §1.3).
 */
export const Sha256Hex = Type.String({ pattern: String.raw`^[0-9a-f]{64}$` });

/** One accounting ledger: the kernel's `EnvelopeSummary` without `critical` (spec §4.1). */
export const LedgerSchema = Type.Object(
  {
    passed: NonNegativeInt,
    failed: NonNegativeInt,
    notTested: NonNegativeInt,
    notTestedByReason: Type.Object(
      Object.fromEntries(NOT_TESTED_REASONS.map((r) => [r, Type.Optional(NonNegativeInt)])),
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const VerificationUnitSchema = literals(VERIFICATION_UNITS);
