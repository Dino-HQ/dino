// packages/core/src/types/dino-result/partitions.ts
import { byCodeUnit } from './canonical';
import type { NotTestedByReason } from '../result-envelope';
import { NOT_TESTED_REASONS } from '../result-envelope';
import { computeHealthScore, executionCoverageFor, runHealth, runTargetUnreachable, verdictDegraded, verdictEmptyRun, verdictIncomplete, verdictReasons, verificationCompleteness } from './derived';
import type { DinoResultV1 } from './v1';
import { ENUMERATION_GAP_REASONS } from './v1-scope';
import { assertNoOutcomeRows, assertPlanSnapshots, assertSnapshots } from './partitions-provenance';
import { DINO_TOOL_NAMES } from './v1-common';
import { TRIM_STEPS } from './v1-verdict';

type Ledger = DinoResultV1['verification']['tools'][number] extends infer T
  ? T extends { status: 'ran'; ledger: infer L }
    ? L
    : never
  : never;
type Finding = DinoResultV1['findings'][number];
type ToolRecord = DinoResultV1['verification']['tools'][number];

/** Thrown when a derived count or ordering disagrees with the collection it summarises (spec §12). */
export class DinoResultPartitionError extends Error {
  constructor(message: string) {
    super(`[dino-result] partition violated: ${message}`);
    this.name = 'DinoResultPartitionError';
  }
}

function fail(message: string): never {
  throw new DinoResultPartitionError(message);
}

const EMPTY_LEDGER = (): Ledger => ({ passed: 0, failed: 0, notTested: 0, notTestedByReason: {} });

function addLedger(into: Ledger, add: Ledger): void {
  into.passed += add.passed;
  into.failed += add.failed;
  into.notTested += add.notTested;
  for (const reason of NOT_TESTED_REASONS) {
    const n = add.notTestedByReason[reason];
    if (n !== undefined && n > 0) into.notTestedByReason[reason] = (into.notTestedByReason[reason] ?? 0) + n;
  }
}

function sameLedger(a: Ledger, b: Ledger): boolean {
  if (a.passed !== b.passed || a.failed !== b.failed || a.notTested !== b.notTested) return false;
  return NOT_TESTED_REASONS.every((r) => (a.notTestedByReason[r] ?? 0) === (b.notTestedByReason[r] ?? 0));
}

function reasonSum(map: NotTestedByReason): number {
  return NOT_TESTED_REASONS.reduce((sum, r) => sum + (map[r] ?? 0), 0);
}

/** An unambiguous tuple encoding: no component can straddle a boundary whatever characters it holds (review 4 M‑1). */
export const tupleKey = (...parts: readonly (string | null)[]): string => JSON.stringify(parts);

function findingSubject(t: Finding['target']): string {
  if (t.kind === 'operation') return tupleKey(t.protocol, t.operationKey);
  return t.kind === 'schema-element' ? t.elementKey : t.tool;
}

/** The §7 identity of a finding row; same key = same finding. */
export function findingKey(f: Finding): string {
  const t = f.target;
  const subject = findingSubject(t);
  return tupleKey(t.kind, subject, f.tool, f.authState ?? null, f.classification);
}

const TOOL_MATRIX: readonly string[] = [...DINO_TOOL_NAMES].sort(byCodeUnit);

/** Every Dino tool appears exactly once per matrix: omission is never a silent fifth state (review 3 C‑2). */
function assertToolMatrix(r: DinoResultV1): void {
  const complete = (names: readonly string[]): boolean => names.length === TOOL_MATRIX.length && names.every((n, i) => n === TOOL_MATRIX[i]);
  if (!complete(r.verification.tools.map((t) => t.tool))) fail('verification.tools must carry every Dino tool exactly once');
  for (const op of r.operations) {
    if (!complete(op.tools.map((t) => t.tool))) fail(`operations[${op.operationKey}].tools must carry every Dino tool exactly once`);
  }
}

/**
 * Every finding target resolves (review 3 C‑3) and its tool was active: an operation or schema-element
 * finding needs a ran tool, a run-level finding a ran or unavailable one (a crash envelope); a not-selected
 * or excluded tool emits nothing.
 */
/** A ran tool emits findings; the only unavailable execution that does is a crash (its crash envelope). */
function assertFindingFromActiveTool(f: Finding, records: ReadonlyMap<string, ToolRecord>): void {
  const record = records.get(f.tool);
  const crashed = record?.status === 'unavailable' && record.execution === 'crashed';
  if (record?.status !== 'ran' && !(f.target.kind === 'run' && crashed)) fail(`finding from ${f.tool}, which is ${record?.status ?? 'unknown'}, cannot exist`);
  // The crash finding is reserved for a crashed record (Codex review): a completed tool never carries one.
  if (f.classification === 'TOOL_CRASH' && !crashed) fail(`a TOOL_CRASH finding from ${f.tool} needs a crashed record`);
}

/** Shape rules a finding must meet on its own: the rbac wire contract carries an auth state on every rbac finding except the crash finding (Codex review). */
function assertFindingShapes(r: DinoResultV1): void {
  for (const f of r.findings) {
    const rbac = f.tool === 'rbac-matrix' && f.classification !== 'TOOL_CRASH';
    if (rbac && (f.authState ?? '') === '') fail('an rbac finding carries its auth state');
    // Only rbac carries a role dimension; anywhere else an auth state would mint extra identities (Codex review).
    if (!rbac && f.authState !== undefined) fail(`a ${f.tool} finding carries no auth state`);
  }
}

/** A crashed tool carries exactly the producer's locked crash finding: one run-level TOOL_CRASH, CRITICAL, count 1 (Codex review). */
function assertCrashFindings(r: DinoResultV1): void {
  for (const t of r.verification.tools) {
    if (t.status !== 'unavailable' || t.execution !== 'crashed') continue;
    const own = r.findings.filter((f) => f.tool === t.tool);
    const [only] = own;
    const locked = own.length === 1 && only !== undefined && only.target.kind === 'run' && only.classification === 'TOOL_CRASH' && only.normalizedLevel === 'CRITICAL' && only.count === 1;
    if (!locked) fail(`verification.tools[${t.tool}]: a crashed tool carries exactly one run-level TOOL_CRASH CRITICAL finding`);
  }
}

function assertFindingTargets(r: DinoResultV1): void {
  const ops = new Map(r.operations.map((o) => [tupleKey(o.protocol, o.operationKey), o]));
  const records = new Map(r.verification.tools.map((t) => [t.tool, t]));
  for (const f of r.findings) {
    const t = f.target;
    assertFindingFromActiveTool(f, records);
    if (t.kind === 'run') {
      if (t.tool !== f.tool) fail(`run-level finding for ${f.tool} targets ${t.tool}`);
      continue;
    }
    if (t.kind !== 'operation') continue;
    const op = ops.get(tupleKey(t.protocol, t.operationKey));
    if (op === undefined) fail(`finding targets unknown operation ${t.protocol} ${t.operationKey}`);
    const row = op.tools.find((x) => x.tool === f.tool);
    if (row?.disposition !== 'planned' || row.cardinality !== 'known') fail(`finding for ${f.tool} on ${t.operationKey} has no finding-capable row`);
  }
}

/** Canonical identity is enforced, not documented (closure C‑4): GraphQL is `kind:name` with a kind, REST carries none. */
function assertOperationIdentity(r: DinoResultV1): void {
  for (const op of r.operations) {
    if (op.protocol === 'rest') {
      if (op.kind !== undefined) fail(`operations[${op.operationKey}]: a REST operation carries no GraphQL kind`);
      continue;
    }
    if (op.kind === undefined) fail(`operations[${op.operationKey}]: a GraphQL operation requires its kind`);
    if (op.operationKey !== `${op.kind}:${op.name}`) fail(`operations[${op.operationKey}]: GraphQL identity must be kind:name`);
  }
}

const ENUMERATION_GAPS: ReadonlySet<string> = new Set(ENUMERATION_GAP_REASONS);

/** `scopeState` is exactly the enumeration-gap rule: UNKNOWN iff an enumeration gap is present (spec-scope §2.2). */
function assertScopeGaps(r: DinoResultV1): void {
  const enumerationGap = r.scope.gaps.some((g) => ENUMERATION_GAPS.has(g.reason));
  if (r.scope.scopeState === 'KNOWN' && enumerationGap) fail('scope cannot be KNOWN beside an enumeration gap');
  if (r.scope.scopeState === 'UNKNOWN' && !enumerationGap) fail('scope cannot be UNKNOWN without an enumeration gap');
}

function assertOperationCount(r: DinoResultV1): void {
  const known = r.scope.scopeState === 'KNOWN';
  if (known && r.verdict.operationCount !== r.operations.length) fail('operationCount must equal operations.length when scope is KNOWN');
  if (!known && r.verdict.operationCount !== null) fail('operationCount must be null when scope is UNKNOWN');
}

/** Worst of the known rows where UNTESTED dominates CLEAN and a real finding wins (the engine's merge rule). */
function mergeLevels(levels: readonly string[]): string {
  let worst = 'CLEAN';
  let untested = false;
  for (const level of levels) {
    if (level === 'UNTESTED') untested = true;
    else if ((LEVEL_RANK[level] ?? 99) < (LEVEL_RANK[worst] ?? 99)) worst = level;
  }
  return worst === 'CLEAN' && (untested || levels.length === 0) ? 'UNTESTED' : worst;
}

type Op = DinoResultV1['operations'][number];

/** Exact per-operation health from the same owner the constructor uses; null exactly when untested or of unknown structure. */
function assertOperationHealth(op: Op, worst: string): void {
  const byTool: Record<string, { severity: Op['worstSeverity'] }> = {};
  for (const t of op.tools) if (t.disposition === 'planned' && t.cardinality === 'known') byTool[t.tool] = { severity: t.severity };
  const expected = !op.tested || op.deprecated === null ? null : computeHealthScore({ worstSeverity: worst as Op['worstSeverity'], byTool }, op.coverageStatus, op.deprecated);
  if (op.healthScore !== expected) fail(`operations[${op.operationKey}].healthScore must be ${String(expected)}`);
}

/** Execution coverage and its reason are exactly the owner's output over the rows and tool records (review 6 C‑1). */
function assertExecutionCoverage(r: DinoResultV1, op: Op): void {
  const expected = executionCoverageFor(op, r.verification.tools);
  if (op.executionCoverage !== expected.executionCoverage || op.executionCoverageReason !== expected.executionCoverageReason) {
    const because = expected.executionCoverageReason === undefined ? '' : ` (${expected.executionCoverageReason})`;
    fail(`operations[${op.operationKey}].executionCoverage must be ${expected.executionCoverage}${because}`);
  }
}

/** Legal `status × execution × reason` combinations — what the producer can emit and nothing else (review 6 M‑2). */
const UNAVAILABLE_EXECUTION: Readonly<Record<string, readonly string[]>> = {
  'tool-failed': ['failed', 'crashed', 'timeout'],
  'budget-cut': ['budget-cut'],
  'run-cancelled': ['cancelled'],
  'circuit-breaker': ['skipped'],
  'not-executed': ['not-run'],
  'reduced-introspection': ['completed'],
  'requires-auth': ['completed'],
  'no-testable-operations': ['completed'],
};

function assertToolRecords(r: DinoResultV1): void {
  for (const t of r.verification.tools) {
    if (t.status === 'ran' && t.execution !== 'completed') fail(`verification.tools[${t.tool}]: a ran tool completed`);
    // The producer's own `ran` rule: adjudicated counters, examined operations, or an unreachable target.
    if (t.status === 'ran' && t.ledger.passed + t.ledger.failed === 0 && t.examinedOperations === 0 && !t.targetUnreachable) fail(`verification.tools[${t.tool}]: a ran tool shows real work`);
    // A ran tool's envelope declares its unit; only a crash envelope carries none, and a crash is unavailable (Codex review).
    if (t.status === 'ran' && t.unit === null) fail(`verification.tools[${t.tool}]: a ran tool declares its verification unit`);
    if (t.status === 'unavailable' && !(UNAVAILABLE_EXECUTION[t.reason] ?? []).includes(t.execution)) fail(`verification.tools[${t.tool}]: ${t.reason} cannot carry execution ${t.execution}`);
  }
}

type Row = Op['tools'][number];

/** The row disposition a run-level status allows (closure C‑1). */
function rowAllowedBy(record: ToolRecord, row: Row): boolean {
  const excludedAs = (...reasons: string[]): boolean => row.disposition === 'excluded' && reasons.includes(row.reason);
  if (record.status === 'not-selected') return excludedAs('not-selected');
  if (record.status === 'excluded') return excludedAs(record.reason, 'not-applicable-protocol');
  return !excludedAs('not-selected', 'requires-roles');
}

const ROW_RULE: Readonly<Record<ToolRecord['status'], string>> = {
  'not-selected': 'excluded as not-selected',
  excluded: 'excluded for that reason',
  unavailable: 'not excluded at run level',
  ran: 'not excluded at run level',
};

/** The run-level status and the operation-level disposition of one tool agree (closure C‑1). */
function assertToolConsistent(op: Op, row: Row, record: ToolRecord): void {
  const where = `operations[${op.operationKey}].tools[${row.tool}]`;
  if (!rowAllowedBy(record, row)) fail(`${where}: a ${record.status} tool is ${ROW_RULE[record.status]}`);
  const worked = row.disposition === 'planned' && row.cardinality === 'known' && (row.ledger.passed + row.ledger.failed > 0 || row.findingCount > 0);
  if (worked && record.status !== 'ran') fail(`${where}: adjudicated work or findings require a ran tool`);
}

/** A row's severity, classifications and examples carry its own findings (closure C‑2). */
function assertRowCarriesFindings(op: Op, row: Row, findings: readonly Finding[]): void {
  if (row.disposition !== 'planned' || row.cardinality !== 'known') {
    if (findings.length > 0) fail(`operations[${op.operationKey}].tools[${row.tool}]: findings on a row that is not finding-capable`);
    return;
  }
  const where = `operations[${op.operationKey}].tools[${row.tool}]`;
  const worst = mergeLevels(findings.map((f) => f.normalizedLevel).filter((l) => l !== 'INFO'));
  if (findings.some((f) => f.normalizedLevel !== 'INFO') && (LEVEL_RANK[row.severity] ?? 99) > (LEVEL_RANK[worst] ?? 99)) fail(`${where}: severity ${row.severity} is below its findings (${worst})`);
  for (const f of findings) if (!row.classifications.includes(f.classification)) fail(`${where}: classification ${f.classification} is missing from the row`);
  const examples = [...new Set(findings.flatMap((f) => f.examples))].sort(byCodeUnit);
  if (row.examples.length !== examples.length || row.examples.some((e, i) => e !== examples[i])) fail(`${where}: examples must be the sorted union of the row's findings`);
}

function assertCrossMatrix(r: DinoResultV1): void {
  const records = new Map(r.verification.tools.map((t) => [t.tool, t]));
  const byRow = new Map<string, Finding[]>();
  for (const f of r.findings) {
    if (f.target.kind !== 'operation') continue;
    const key = tupleKey(f.target.protocol, f.target.operationKey, f.tool);
    byRow.set(key, [...(byRow.get(key) ?? []), f]);
  }
  for (const op of r.operations) {
    for (const row of op.tools) {
      const record = records.get(row.tool);
      if (record === undefined) fail(`operations[${op.operationKey}].tools[${row.tool}] has no run-level record`);
      assertToolConsistent(op, row, record);
      assertRowCarriesFindings(op, row, byRow.get(tupleKey(op.protocol, op.operationKey, row.tool)) ?? []);
    }
  }
}

/** The run-level unreachable flag is the owner's projection over the ran REST-request records, in both directions (Codex review). */
function assertTargetUnreachable(r: DinoResultV1): void {
  const expected = runTargetUnreachable(r.verification.tools);
  if (r.verification.targetUnreachable !== expected) fail(`verification.targetUnreachable must be ${String(expected)} from the ran REST-request tool records`);
}

/** Reasons are exactly the owner's projection over the stored data; trim provenance is ordered and unique (closure C‑3, Codex). */
function assertReasons(r: DinoResultV1): void {
  const expected = verdictReasons({ degraded: r.verdict.degraded, emptyRun: r.verdict.emptyRun, scope: r.scope, verification: r.verification, provenance: r.provenance });
  if (r.verdict.reasons.length !== expected.length || r.verdict.reasons.some((reason, i) => reason !== expected[i])) fail(`verdict.reasons must be exactly [${expected.join(', ')}] from the stored records`);
  // Only stages that removed bytes are recorded, in the fixed order, once each.
  const order = r.provenance.trimmed.map((step) => TRIM_STEPS.indexOf(step));
  if (order.some((i, n) => i < 0 || (n > 0 && i <= (order[n - 1] ?? -1)))) fail('provenance.trimmed must follow the fixed trim order without repeats');
}

/** The verdict's incompleteness, coverage and completeness are the owners' outputs over the stored data (review 6 C‑2/C‑3). */
function assertVerdictDerivations(r: DinoResultV1): void {
  const degraded = verdictDegraded(r.verification.tools);
  if (r.verdict.degraded !== degraded) fail(`verdict.degraded must be ${String(degraded)} from the stored tool records`);
  const emptyRun = verdictEmptyRun(r.verification.tools);
  if (r.verdict.emptyRun !== emptyRun) fail(`verdict.emptyRun must be ${String(emptyRun)} from the stored tool records`);
  const incomplete = verdictIncomplete({ scope: r.scope, verification: r.verification, operations: r.operations, degraded: r.verdict.degraded, emptyRun: r.verdict.emptyRun });
  if (r.verdict.incomplete !== incomplete) fail(`verdict.incomplete must be ${String(incomplete)} from the stored verification`);
  if (r.verdict.coverage !== (incomplete ? 'partial' : 'full')) fail('verdict.coverage must be partial exactly when incomplete');
  const completeness = verificationCompleteness(r.verification.tools);
  if (r.verdict.completeness !== completeness) fail(`verdict.completeness must be ${completeness} (verification-completeness-v1)`);
}

/** An operation's aggregate is a function of its rows, never a free claim (review 4 M‑2, review 5 C‑2). */
function assertOperationAggregates(r: DinoResultV1): void {
  for (const op of r.operations) {
    const known = op.tools.flatMap((t) => (t.disposition === 'planned' && t.cardinality === 'known' ? [t.severity] : []));
    const worst = mergeLevels(known);
    if (op.worstSeverity !== worst) fail(`operations[${op.operationKey}].worstSeverity must be ${worst} from its rows`);
    if (op.tested !== (worst !== 'UNTESTED')) fail(`operations[${op.operationKey}].tested must follow worstSeverity`);
    assertOperationHealth(op, worst);
    assertExecutionCoverage(r, op);
  }
  const health = runHealth(r.operations, r.verdict.coverage);
  const v = r.verdict.health;
  if (v.level !== health.level || v.score !== health.score || v.verdict !== health.verdict) fail(`verdict.health must be ${health.level}/${String(health.score)}/${health.verdict} from the operations`);
}

function assertDispositions(r: DinoResultV1): void {
  let planned = 0;
  let excluded = 0;
  for (const op of r.operations) {
    for (const row of op.tools) {
      if (row.disposition === 'planned') planned += 1;
      else excluded += 1;
    }
  }
  if (r.scope.dispositions.planned !== planned || r.scope.dispositions.excluded !== excluded) fail('scope.dispositions must count the operation × tool rows');
}

/** Per-tool sum of the known planned rows; each row's reasons must sum to its notTested. */
function rowLedgerSums(r: DinoResultV1): Map<string, Ledger> {
  const perTool = new Map<string, Ledger>();
  for (const op of r.operations) {
    for (const row of op.tools) {
      if (row.disposition !== 'planned' || row.cardinality !== 'known') continue;
      if (reasonSum(row.ledger.notTestedByReason) !== row.ledger.notTested) fail(`row ledger reasons must sum to notTested (${op.operationKey}/${row.tool})`);
      const acc = perTool.get(row.tool) ?? EMPTY_LEDGER();
      addLedger(acc, row.ledger);
      perTool.set(row.tool, acc);
    }
  }
  return perTool;
}

/** Each ran tool's ledger = Σ its rows + nonOperationUnits; returns the merged ledger per unit. */
function toolLedgerSums(r: DinoResultV1, perTool: Map<string, Ledger>): Map<string, Ledger> {
  const byUnit = new Map<string, Ledger>();
  for (const t of r.verification.tools) {
    if (t.status !== 'ran') continue;
    if (reasonSum(t.ledger.notTestedByReason) !== t.ledger.notTested) fail(`tool ledger reasons must sum to notTested (${t.tool})`);
    const expected = perTool.get(t.tool) ?? EMPTY_LEDGER();
    addLedger(expected, t.nonOperationUnits);
    if (!sameLedger(expected, t.ledger)) fail(`tool ledger must equal the sum of its operation rows plus nonOperationUnits (${t.tool})`);
    if (t.unit === null) continue;
    const acc = byUnit.get(t.unit) ?? EMPTY_LEDGER();
    addLedger(acc, t.ledger);
    byUnit.set(t.unit, acc);
  }
  return byUnit;
}

function assertLedgers(r: DinoResultV1): void {
  const byUnit = toolLedgerSums(r, rowLedgerSums(r));
  for (const [unit, expected] of byUnit) {
    const actual = r.verification.byUnit[unit as keyof typeof r.verification.byUnit];
    if (actual === undefined || !sameLedger(actual, expected)) fail(`byUnit.${unit} must equal the merged ledgers of its tools`);
  }
  for (const unit of Object.keys(r.verification.byUnit)) if (!byUnit.has(unit)) fail(`byUnit.${unit} has no tool with that unit`);
}

/** Σ count per (tool, protocol, operationKey); findings must be unique by their §7 key. */
function findingMassByRow(findings: readonly Finding[]): Map<string, number> {
  const seen = new Set<string>();
  const perRow = new Map<string, number>();
  for (const f of findings) {
    const key = findingKey(f);
    if (seen.has(key)) fail(`duplicate finding ${key.replaceAll(' ', '|')}`);
    seen.add(key);
    if (f.target.kind !== 'operation') continue;
    const rowKey = `${f.tool} ${f.target.protocol} ${f.target.operationKey}`;
    perRow.set(rowKey, (perRow.get(rowKey) ?? 0) + f.count);
  }
  return perRow;
}

function assertFindings(r: DinoResultV1): void {
  const perRow = findingMassByRow(r.findings);
  for (const op of r.operations) {
    for (const row of op.tools) {
      if (row.disposition !== 'planned' || row.cardinality !== 'known') continue;
      const expected = perRow.get(`${row.tool} ${op.protocol} ${op.operationKey}`) ?? 0;
      if (row.findingCount !== expected) fail(`findingCount must equal Σ count of findings for (${row.tool}, ${op.operationKey})`);
    }
  }
}

const LEVEL_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function assertOverallSeverity(r: DinoResultV1): void {
  let scored = 'CLEAN';
  for (const f of r.findings) {
    const rank = LEVEL_RANK[f.normalizedLevel];
    if (rank !== undefined && (scored === 'CLEAN' || rank < (LEVEL_RANK[scored] ?? 99))) scored = f.normalizedLevel;
  }
  const v = r.verdict;
  const expected = v.degraded || v.emptyRun || (v.incomplete && scored === 'CLEAN') ? 'UNTESTED' : scored;
  if (v.overallSeverity !== expected) fail(`overallSeverity must be ${expected} under the UNTESTED-floor rule`);
}

function isSorted(keys: readonly string[], label: string): void {
  for (let i = 1; i < keys.length; i += 1) {
    const prev = keys[i - 1] ?? '';
    const cur = keys[i] ?? '';
    if (cur < prev) fail(`${label} must be sorted by code unit (${prev} > ${cur})`);
    if (cur === prev) fail(`${label} must not repeat (${cur})`);
  }
}

function assertOrdering(r: DinoResultV1): void {
  isSorted(r.operations.map((o) => `${o.protocol}\0${o.operationKey}`), 'operations');
  for (const op of r.operations) {
    isSorted(op.tools.map((t) => t.tool), `operations[${op.operationKey}].tools`);
    for (const row of op.tools) {
      if (row.disposition === 'planned' && row.cardinality === 'known') {
        isSorted(row.classifications, `operations[${op.operationKey}].tools[${row.tool}].classifications`);
        isSorted(row.examples, `operations[${op.operationKey}].tools[${row.tool}].examples`);
      }
    }
  }
  isSorted(r.verification.tools.map((t) => t.tool), 'verification.tools');
  for (const t of r.verification.tools) if (t.status === 'ran') isSorted(t.examinedProtocols, `verification.tools[${t.tool}].examinedProtocols`);
  isSorted(r.findings.map(findingKey), 'findings');
  for (const f of r.findings) isSorted(f.examples, `findings[${f.classification}].examples`);
  isSorted(r.verdict.reasons, 'verdict.reasons');
  isSorted(r.scope.snapshots.map((s) => s.source), 'scope.snapshots');
  isSorted(r.scope.gaps.map((g) => `${g.tool ?? ''} ${g.source ?? ''} ${g.reason}`), 'scope.gaps');
}

/** Every derived count and ordering the result carries must agree with the collection it summarises. */
export function assertDinoResultPartitions(r: DinoResultV1): void {
  assertToolMatrix(r);
  assertToolRecords(r);
  assertFindingShapes(r);
  assertOperationIdentity(r);
  assertScopeGaps(r);
  assertOperationCount(r);
  assertOperationAggregates(r);
  assertCrossMatrix(r);
  assertCrashFindings(r);
  assertTargetUnreachable(r);
  assertReasons(r);
  assertVerdictDerivations(r);
  assertDispositions(r);
  assertLedgers(r);
  assertFindings(r);
  assertFindingTargets(r);
  assertOverallSeverity(r);
  assertOrdering(r);
  assertSnapshots(r);
  assertPlanSnapshots(r);
  assertNoOutcomeRows(r);
}
