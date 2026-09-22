// packages/core/src/types/dino-result/v1-verdict.ts
import { Type } from '@sinclair/typebox';
import { DINO_TOOL_NAMES, EnvelopeLevelSchema, IsoInstant, NonNegativeInt, Sha256Hex, type DinoToolName } from './v1-common';

const TargetSchema = Type.Object(
  { url: Type.String({ minLength: 1, maxLength: 2048 }), protected: Type.Boolean() },
  { additionalProperties: false },
);

export const IdentitySchema = Type.Object(
  {
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    tenantId: Type.String({ minLength: 1, maxLength: 200 }),
    environment: Type.String({ minLength: 1, maxLength: 200 }),
    trigger: Type.Union([
      Type.Literal('pr'),
      Type.Literal('nightly'),
      Type.Literal('weekly'),
      Type.Literal('monthly'),
      Type.Literal('manual'),
      Type.Literal('watch'),
    ]),
    generatedAt: IsoInstant,
    /** Engine package version (D17) — never the CLI/runner `agentVersion` (review C‑15). */
    engineVersion: Type.String({ minLength: 1, maxLength: 64 }),
    /** Protocol-bound targets (review C‑7). */
    targets: Type.Object(
      { graphql: Type.Optional(TargetSchema), rest: Type.Optional(TargetSchema) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const VERDICT_REASONS = Object.freeze([
  'ALL_TOOLS_FAILED',
  'EMPTY_RUN',
  'PARTIAL_TOOL_FAILURE',
  'PARTIAL_COVERAGE',
  'TARGET_UNREACHABLE',
  'SCOPE_UNKNOWN',
  'RESULT_TRIMMED',
] as const);
export type VerdictReason = (typeof VERDICT_REASONS)[number];

/** Verification-only, deterministic (review C‑14); reasoning reasons live in `Interpretation`. */
export const VerdictSchema = Type.Object(
  {
    overallSeverity: EnvelopeLevelSchema,
    health: Type.Object(
      {
        score: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
        level: EnvelopeLevelSchema,
        verdict: Type.Union([
          Type.Literal('Critical'),
          Type.Literal('At risk'),
          Type.Literal('Needs attention'),
          Type.Literal('Healthy'),
          Type.Literal('Untested'),
        ]),
      },
      { additionalProperties: false },
    ),
    coverage: Type.Union([Type.Literal('full'), Type.Literal('partial')]),
    /** verification-completeness-v1, the exact double `calculateVerificationConfidence` produces. */
    completeness: Type.Number({ minimum: 0, maximum: 1 }),
    /** `null` whenever `scope.scopeState === 'UNKNOWN'` (review C‑9). */
    operationCount: Type.Union([NonNegativeInt, Type.Null()]),
    degraded: Type.Boolean(),
    emptyRun: Type.Boolean(),
    incomplete: Type.Boolean(),
    reasons: Type.Array(Type.Union(VERDICT_REASONS.map((r) => Type.Literal(r)))),
  },
  { additionalProperties: false },
);

export const TRIM_STEPS = Object.freeze([
  'responseSchemas',
  'requestBody',
  'parameters',
  'findingExamples',
  'toolExamples',
] as const);
export type TrimStep = (typeof TRIM_STEPS)[number];

/** One optional SHA-256 per tool name and nothing else: an invented key or a non-digest value is rejected. */
const PlanSnapshotsSchema = Type.Unsafe<Partial<Record<DinoToolName, string>>>(
  Type.Object(Object.fromEntries(DINO_TOOL_NAMES.map((tool) => [tool, Type.Optional(Sha256Hex)])), { additionalProperties: false }),
);

/** Never references the attestation: the bytes cannot contain their own digest. */
export const ProvenanceSchema = Type.Object(
  {
    /** Per tool that handed back a planner outcome: the digest of the plan that executed (spec-scope §1.6). */
    planSnapshots: Type.Optional(PlanSnapshotsSchema),
    trimmed: Type.Array(Type.Union(TRIM_STEPS.map((s) => Type.Literal(s)))),
  },
  { additionalProperties: false },
);
