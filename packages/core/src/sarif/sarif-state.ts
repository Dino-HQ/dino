/**
 * Dino-owned SARIF reconciliation state (format 1.0). GitHub keeps each alert's fingerprint and payload but
 * strips everything Dino adds, so this file holds only what GitHub drops: each fingerprint's verification
 * unit and the plan it was last verified under. It is read back from a workflow artifact, so it is parsed as
 * untrusted input and refused on any deviation.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { dinoResultDigest } from '../types/dino-result/canonical';
import { canonicalTargetKey } from '../types/dino-result/fingerprint';
import { ProtocolSchema, ToolNameSchema } from '../types/dino-result/v1-common';
import type { DinoResult } from '../types/dino-result/v1';

export const SARIF_STATE_VERSION = '1.0';
const STATEFUL_RUN_SEGMENT = /^s1\.[0-9a-f]{32}$/;
const MAX_ENTRIES = 50_000;

/** The SARIF run segment: never the raw run id, which may contain the `/` GitHub splits the category on. */
export async function sarifRunToken(runId: string, kind: 'stateful' | 'stateless'): Promise<string> {
  return `${kind === 'stateful' ? 's1' : 's0'}.${(await dinoResultDigest(runId)).slice(0, 32)}`;
}

/** Only an analysis uploaded with reconciliation state carries an `s1.` run segment. */
export function isStatefulRunSegment(runSegment: string): boolean {
  return STATEFUL_RUN_SEGMENT.test(runSegment);
}

/** GitHub's own rule: the category is everything before the last `/`, the run everything after it. */
export function splitAutomationId(id: string): { category: string; runSegment: string } {
  const slash = id.lastIndexOf('/');
  return slash < 0 ? { category: '', runSegment: id } : { category: id.slice(0, slash), runSegment: id.slice(slash + 1) };
}

const Short = Type.String({ minLength: 1, maxLength: 512 });
const Sha256 = Type.String({ pattern: '^[0-9a-f]{64}$' });

const SarifUnitSchema = Type.Union([
  Type.Tuple([Type.Literal('operation'), ProtocolSchema, Short, ToolNameSchema]),
  Type.Tuple([Type.Literal('schema-element'), Short, Type.Union([Short, Type.Null()]), ToolNameSchema]),
  Type.Tuple([Type.Literal('run'), ToolNameSchema]),
]);
export type SarifUnit = Static<typeof SarifUnitSchema>;

const SarifStateEntrySchema = Type.Object(
  {
    unit: SarifUnitSchema,
    planSnapshot: Type.Union([Sha256, Type.Null()]),
    lastVerifiedRunId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SarifStateEntry = Static<typeof SarifStateEntrySchema>;

const SarifStateSchema = Type.Object(
  {
    dinoSarifState: Type.Literal(SARIF_STATE_VERSION),
    ref: Short,
    category: Short,
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    runToken: Type.String({ pattern: STATEFUL_RUN_SEGMENT.source }),
    commitSha: Type.String({ pattern: '^[0-9a-f]{40}$' }),
    entries: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), SarifStateEntrySchema),
  },
  { additionalProperties: false },
);
export type SarifState = Static<typeof SarifStateSchema>;

export type ParsedSarifState = { ok: true; state: SarifState } | { ok: false; reason: string };

export function parseSarifState(text: string): ParsedSarifState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the state file is not JSON' };
  }
  if (!Value.Check(SarifStateSchema, raw)) {
    const first = Value.Errors(SarifStateSchema, raw).First();
    return { ok: false, reason: `the state file is not SARIF state ${SARIF_STATE_VERSION} (${first?.path ?? '/'}: ${first?.message ?? 'invalid'})` };
  }
  if (Object.keys(raw.entries).length > MAX_ENTRIES) return { ok: false, reason: 'the state file has too many entries' };
  return { ok: true, state: raw };
}

type Finding = DinoResult['findings'][number];

/** The unit a finding was verified on: protocol-qualified, unlike the fingerprint's target key. */
export function sarifUnitOf(f: Finding): SarifUnit {
  if (f.target.kind === 'operation') return ['operation', f.target.protocol, f.target.operationKey, f.tool];
  if (f.target.kind === 'schema-element') return ['schema-element', f.target.elementKey, f.target.parentType ?? null, f.tool];
  return ['run', f.tool];
}

/** For messages only: the unit in the words the rest of the report uses. */
export function sarifUnitLabel(unit: SarifUnit): string {
  if (unit[0] === 'operation') return `${unit[1]}:${unit[2]} (${unit[3]})`;
  if (unit[0] === 'schema-element') return `${canonicalTargetKey({ kind: 'schema-element', elementKey: unit[1], ...(unit[2] === null ? {} : { parentType: unit[2] }) })} (${unit[3]})`;
  return `the ${unit[1]} run`;
}
