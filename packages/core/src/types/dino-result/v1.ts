// packages/core/src/types/dino-result/v1.ts
import { byCodeUnit } from './canonical';
import { Type, type Static } from '@sinclair/typebox';
import { DINO_TOOL_NAMES } from './v1-common';
import { FindingSchema } from './v1-findings';
import { OperationSchema } from './v1-operations';
import { ScopeSchema } from './v1-scope';
import { IdentitySchema, ProvenanceSchema, VerdictSchema } from './v1-verdict';
import { VerificationSchema } from './v1-verification';

/**
 * `DinoResult 1.0` — the one canonical, immutable, versioned output of the Dino engine
 * (Cleanup V2 task 2).
 * Strict everywhere: unknown keys are rejected, never stripped. Reasoning (`Interpretation`),
 * the attestation and the discovery `SchemaSnapshot` are siblings, never fields.
 */
export const DinoResultV1Schema = Type.Object(
  {
    dinoResult: Type.Literal('1.0'),
    identity: IdentitySchema,
    scope: ScopeSchema,
    operations: Type.Array(OperationSchema),
    verification: VerificationSchema,
    findings: Type.Array(FindingSchema),
    verdict: VerdictSchema,
    provenance: ProvenanceSchema,
  },
  {
    additionalProperties: false,
    // Unicode-escaped like `types/dcg/v1.ts`: a schema id, not a live endpoint (hardcoded-URL drift check).
    $id: '\u0068\u0074\u0074\u0070\u0073://usedino.dev/schema/dino-result.v1.json',
    $schema: '\u0068\u0074\u0074\u0070\u0073://json-schema.org/draft/2020-12/schema',
    title: 'DinoResult v1',
    description: 'The one canonical result of a Dino verification run (dinoResult 1.0).',
  },
);

/** Mutable construction shape (what the constructor assembles before validation). */
export type DinoResultV1 = Static<typeof DinoResultV1Schema>;

export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** The public, deeply read-only contract (review M‑1). Runtime freeze is `freezeDeep`. */
export type DinoResult = DeepReadonly<DinoResultV1>;

/** Smallest valid instance: an empty run with unknown scope. */
export const DINO_RESULT_V1_MINIMAL_EXAMPLE = {
  dinoResult: '1.0' as const,
  identity: {
    runId: 'run-example',
    tenantId: 'tenant',
    environment: 'qa',
    trigger: 'manual' as const,
    generatedAt: '2026-09-10T00:00:00.000Z',
    engineVersion: '0.0.0',
    targets: {},
  },
  // The registry is always admitted: this is the SHA-256 of the canonical bytes of an empty registry (`{}`).
  scope: {
    snapshots: [{ source: 'registry' as const, digest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', capturedAt: '2026-09-10T00:00:00.000Z' }],
    scopeState: 'UNKNOWN' as const,
    gaps: [{ reason: 'no-discovery' as const }],
    dispositions: { planned: 0, excluded: 0 },
  },
  operations: [],
  verification: { targetUnreachable: false, durationMs: 0, tools: [...DINO_TOOL_NAMES].sort(byCodeUnit).map((tool) => ({ tool, status: 'not-selected' as const })), byUnit: {} },
  findings: [],
  verdict: {
    overallSeverity: 'UNTESTED' as const,
    health: { score: null, level: 'UNTESTED' as const, verdict: 'Untested' as const },
    coverage: 'partial' as const,
    completeness: 0,
    operationCount: null,
    degraded: false,
    emptyRun: false,
    incomplete: true,
    reasons: ['SCOPE_UNKNOWN' as const],
  },
  provenance: { trimmed: [] },
} satisfies DinoResultV1;
