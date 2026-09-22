// packages/core/src/types/dino-result/partitions-provenance.ts
/**
 * Provenance partitions of the strict parser (Cleanup V2 task 3, spec-scope §1, §3): the Scope Identity rows a
 * current result must carry, the plan digests in both directions, and the shape a historical import keeps.
 * Sealed with `partitions.ts`; `fail` throws the same `DinoResultPartitionError`.
 */
import { DinoResultPartitionError } from './partitions';
import type { DinoResultV1 } from './v1';

type ToolRecord = DinoResultV1['verification']['tools'][number];

function fail(message: string): never {
  throw new DinoResultPartitionError(message);
}

/** A result imported from a blob that never stored discovery (spec-scope §3): no snapshots, no plan digests to require. */
const historical = (r: DinoResultV1): boolean => r.scope.gaps.some((g) => g.reason === 'historical-no-discovery');

/** The registry is always admitted and a run with a target always identifies it (spec-scope §1.1); a historical import carries neither. */
export function assertSnapshots(r: DinoResultV1): void {
  if (historical(r)) {
    if (r.scope.snapshots.length > 0) fail('a historical import carries no scope snapshots');
    return;
  }
  const sources = new Set(r.scope.snapshots.map((s) => s.source));
  if (!sources.has('registry')) fail('scope.snapshots must carry the registry');
  // The producer fails closed without a structural source (`no-discovery`): a KNOWN enumeration always has one (Codex).
  if (r.scope.scopeState === 'KNOWN' && !['introspection', 'sdl', 'openapi'].some((s) => sources.has(s as (typeof r.scope.snapshots)[number]['source']))) fail('a KNOWN scope carries at least one structural source identity');
  if (sources.has('targets') !== Object.keys(r.identity.targets).length > 0) fail('scope.snapshots carries targets iff identity.targets is non-empty');
}

/** Without a planner outcome the producer cannot decide a tool's rows: every applicable row is planned/unknown, never known and never `not-planned`. */
export function assertNoOutcomeRows(r: DinoResultV1): void {
  const noOutcome = new Set(r.scope.gaps.filter((g) => g.reason === 'no-planner-outcome').map((g) => g.tool));
  // The producer's only dispositions without an outcome: a protocol/policy exclusion, or planned with unknown cardinality.
  const decided = (row: DinoResultV1['operations'][number]['tools'][number]): boolean => (row.disposition === 'planned' ? row.cardinality === 'known' : row.reason === 'not-planned');
  const rows = r.operations.flatMap((op) => op.tools.filter((row) => noOutcome.has(row.tool) && decided(row)).map((row) => `${op.operationKey}/${row.tool}`));
  if (rows.length > 0) fail(`operations[${rows[0]}]: a tool without a planner outcome has no known or not-planned row`);
}

/**
 * Plan provenance in both directions (spec-scope §1.6): a tool that could plan (ran or unavailable) carries its
 * plan digest exactly when it handed back a planner outcome — i.e. unless the result records `no-planner-outcome`
 * for it; an excluded or not-selected tool never carries one. A historical import carries none.
 */
export function assertPlanSnapshots(r: DinoResultV1): void {
  const digests = r.provenance.planSnapshots ?? {};
  const noOutcome = new Set(r.scope.gaps.filter((g) => g.reason === 'no-planner-outcome').map((g) => g.tool));
  for (const t of r.verification.tools) assertPlanDigest(t, Object.hasOwn(digests, t.tool), noOutcome.has(t.tool), historical(r));
}

function assertPlanDigest(t: ToolRecord, has: boolean, noOutcome: boolean, imported: boolean): void {
  if (t.status !== 'ran' && t.status !== 'unavailable') {
    if (has) fail(`provenance.planSnapshots[${t.tool}]: a ${t.status} tool never planned`);
    return;
  }
  if (imported) {
    if (has) fail(`provenance.planSnapshots[${t.tool}]: a historical import carries no plan digests`);
    return;
  }
  if (noOutcome && has) fail(`provenance.planSnapshots[${t.tool}]: a tool without a planner outcome has no plan digest`);
  if (!noOutcome && !has) fail(`provenance.planSnapshots[${t.tool}]: a tool that planned carries its plan digest`);
}
