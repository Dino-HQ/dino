// packages/core/src/types/dino-result/v1-scope.ts
import { Type } from '@sinclair/typebox';
import { IsoInstant, literals, NonNegativeInt, Sha256Hex, ToolNameSchema } from './v1-common';

export const SnapshotSourceSchema = Type.Union([
  Type.Literal('introspection'),
  Type.Literal('sdl'),
  Type.Literal('openapi'),
  Type.Literal('registry'),
  Type.Literal('targets'),
]);

/** Gaps that say the enumeration itself was incomplete: any one of them makes the scope UNKNOWN (spec-scope §2.1). */
export const ENUMERATION_GAP_REASONS = Object.freeze([
  'no-discovery',
  'reduced-introspection',
  'not-in-discovery',
  'operation-unresolved-in-spec',
  'undeclared-source',
  'historical-no-discovery',
] as const);
/** The closed 1.0 gap vocabulary: the enumeration gaps plus the per-tool, non-enumeration ones. */
export const SCOPE_GAP_REASONS = Object.freeze([
  ...ENUMERATION_GAP_REASONS,
  'no-planner-outcome',
  'plan-formation-gap',
  'ambiguous-graphql-identity',
] as const);
export type ScopeGapReason = (typeof SCOPE_GAP_REASONS)[number];
export const ScopeGapReasonSchema = literals(SCOPE_GAP_REASONS);

/**
 * Scope Identity + Scope Ledger (spec §10, semantics locked in spec-scope.md). The engine owns both: hosts
 * declare which discovery sources they read; the constructor projects, canonicalises and digests the
 * admitted material, and derives every gap from the planners' own accounting.
 */
export const ScopeSchema = Type.Object(
  {
    snapshots: Type.Array(
      Type.Object(
        {
          source: SnapshotSourceSchema,
          digest: Sha256Hex,
          capturedAt: IsoInstant,
        },
        { additionalProperties: false },
      ),
    ),
    /** Whether discovery itself was enumerable. Never flipped by an unknown tool cardinality. */
    scopeState: Type.Union([Type.Literal('KNOWN'), Type.Literal('UNKNOWN')]),
    /** Run/tool-level discovery gaps; never a fabricated operation row. */
    gaps: Type.Array(
      Type.Object(
        {
          tool: Type.Optional(ToolNameSchema),
          source: Type.Optional(SnapshotSourceSchema),
          reason: ScopeGapReasonSchema,
        },
        { additionalProperties: false },
      ),
    ),
    /** Counts of operation × tool scopes — never equated to `operations.length`. */
    dispositions: Type.Object(
      { planned: NonNegativeInt, excluded: NonNegativeInt },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
