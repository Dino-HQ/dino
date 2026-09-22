// packages/core/src/types/dino-result/derived.ts
/**
 * Derived-truth owners the canonical result stores AND the strict parser re-derives (review 5/6): tool
 * applicability, per-operation health, execution coverage, run health, incompleteness and verification
 * completeness. The engine imports these; nothing here reads the engine. Every table is frozen data
 * behind a pure accessor — no mutable authority is exported (review 6 C‑5).
 */
import type { EnvelopeSeverityLevel } from '../result-envelope';
import { byCodeUnit } from './canonical';
import type { DinoResultV1 } from './v1';
import type { DINO_TOOL_NAMES } from './v1-common';

type ToolName = (typeof DINO_TOOL_NAMES)[number];
type Protocol = 'graphql' | 'rest';
type Operation = DinoResultV1['operations'][number];
type VerificationTools = DinoResultV1['verification']['tools'];

export type CoverageStatus = 'documented-and-tested' | 'documented-only' | 'absent' | 'unknown';
export type HealthVerdict = 'Critical' | 'At risk' | 'Needs attention' | 'Healthy' | 'Untested';
export type ExecutionCoverage = { executionCoverage: 'tested' | 'partially-tested' | 'not-tested'; executionCoverageReason?: string };

/** Verified matrix (pipeline-tools + runner). */
const TOOL_PROTOCOL: Readonly<Record<ToolName, 'graphql' | 'rest' | 'both'>> = Object.freeze({
  'input-fuzzer': 'graphql',
  'response-validator': 'both',
  'deprecation-tracker': 'both',
  'rate-limit-validator': 'both',
  'rest-fuzzer': 'rest',
  'rbac-matrix': 'both',
  'error-code-validator': 'both',
});

/**
 * Whether a tool emits per-op entries for clean operations. Coupled to each wrapper's clean-op entry
 * behaviour; a `Record<ToolName, boolean>` forces a decision for every tool.
 */
const EMITS_CLEAN: Readonly<Record<ToolName, boolean>> = Object.freeze({
  'response-validator': true,
  'rest-fuzzer': true,
  'error-code-validator': true,
  'input-fuzzer': true,
  'rbac-matrix': true,
  'rate-limit-validator': true,
  'deprecation-tracker': false,
});

export function toolProtocol(tool: string): 'graphql' | 'rest' | 'both' | undefined {
  return Object.hasOwn(TOOL_PROTOCOL, tool) ? TOOL_PROTOCOL[tool as ToolName] : undefined;
}

/** A tool applies to an operation when its protocol is `both` or matches; an unknown tool applies (denylist). */
export function toolAppliesTo(tool: string, protocol: Protocol): boolean {
  const p = toolProtocol(tool);
  return p === undefined || p === 'both' || p === protocol;
}

export function emitsCleanEntries(tool: string): boolean {
  return Object.hasOwn(EMITS_CLEAN, tool) ? EMITS_CLEAN[tool as ToolName] : false;
}

const HEALTH_DEDUCTION: Record<string, number> = { CRITICAL: 40, HIGH: 25, MEDIUM: 10, LOW: 3, CLEAN: 0, UNTESTED: 0 };

/** Per-operation health, 0–100: deductions per tool severity, zero on any CRITICAL, minus 5 when deprecated. */
export function computeHealthScore(
  toolFindings: { worstSeverity: EnvelopeSeverityLevel; byTool: Record<string, { severity: EnvelopeSeverityLevel }> },
  coverageStatus: CoverageStatus,
  deprecated: boolean,
): number {
  if (toolFindings.worstSeverity === 'UNTESTED') {
    let score = 30;
    if (coverageStatus === 'absent') score -= 10;
    if (deprecated) score -= 5;
    return Math.max(0, score);
  }
  let score = 100;
  for (const tool of Object.values(toolFindings.byTool)) score -= HEALTH_DEDUCTION[tool.severity] ?? 15;
  if (Object.values(toolFindings.byTool).some((t) => t.severity === 'CRITICAL')) score = 0;
  if (deprecated) score -= 5;
  const result = Math.max(0, Math.min(100, score));
  return Number.isNaN(result) ? 0 : result;
}

/** INV-1: 'Critical' iff CRITICAL. INV-2: 'Healthy' iff CLEAN. */
export function healthVerdict(level: EnvelopeSeverityLevel): HealthVerdict {
  if (level === 'CRITICAL') return 'Critical';
  if (level === 'HIGH') return 'At risk';
  if (level === 'MEDIUM' || level === 'LOW') return 'Needs attention';
  return level === 'CLEAN' ? 'Healthy' : 'Untested';
}

const LEVEL_CASCADE: readonly EnvelopeSeverityLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNTESTED'];

/**
 * Run health over the operation collection: level cascade CRITICAL > HIGH > MEDIUM > LOW > UNTESTED > CLEAN,
 * an empty collection is UNTESTED, and the score is the rounded mean of the scored operations unless the
 * level is UNTESTED or coverage is partial.
 */
export function runHealth(
  operations: readonly { worstSeverity: EnvelopeSeverityLevel; healthScore: number | null }[],
  coverage: 'full' | 'partial',
): { score: number | null; level: EnvelopeSeverityLevel; verdict: HealthVerdict } {
  const levels = new Set(operations.map((o) => o.worstSeverity));
  const level = operations.length === 0 ? 'UNTESTED' : (LEVEL_CASCADE.find((l) => levels.has(l)) ?? 'CLEAN');
  const scored = operations.flatMap((o) => (o.healthScore === null ? [] : [o.healthScore]));
  const score = level === 'UNTESTED' || coverage === 'partial' || scored.length === 0 ? null : Math.round(scored.reduce((a, b) => a + b, 0) / scored.length);
  return { score, level, verdict: healthVerdict(level) };
}

// ── Execution coverage (#2305, #2311, #2319) ─────────────────────────────────────────────────────────

export interface CoverageToolFindings {
  toolsRun: readonly string[];
  worstSeverity: EnvelopeSeverityLevel;
  byTool: Record<string, { severity: EnvelopeSeverityLevel; classifications?: readonly string[] | undefined; findingCount?: number | undefined; examples?: readonly string[] | undefined }>;
}
export interface CoverageLedgerEntry {
  tool: string;
  status: 'ran' | 'excluded' | 'unavailable';
  reason?: string | undefined;
  examinedProtocols?: readonly Protocol[] | undefined;
}

/**
 * Per-operation Dino-execution coverage from tool findings + the honest tool ledger. Denylist: a tool is
 * a gap unless it ran (and examined this protocol), is `not-applicable-protocol`, or its protocol does
 * not match this op. Emit-clean tools need a `byTool` entry to cover an op; a `byTool` entry classified
 * INTROSPECTION_SKIPPED or of severity UNTESTED is a gap, not coverage. Pure.
 */
export function deriveExecutionCoverage(toolFindings: CoverageToolFindings, toolLedger: readonly CoverageLedgerEntry[], opProtocol: Protocol): ExecutionCoverage {
  const byToolMap = new Map(Object.entries(toolFindings.byTool));
  const untestedForOp = (tool: string): boolean => byToolMap.get(tool)?.severity === 'UNTESTED';
  const hasRealCoverage = (tool: string): boolean => {
    const entry = byToolMap.get(tool);
    return entry !== undefined && !(entry.classifications?.includes('INTROSPECTION_SKIPPED') ?? false);
  };
  const coversThisOp = (e: CoverageLedgerEntry): boolean =>
    e.status === 'ran' &&
    (e.examinedProtocols === undefined || e.examinedProtocols.includes(opProtocol)) &&
    !untestedForOp(e.tool) &&
    (!emitsCleanEntries(e.tool) || hasRealCoverage(e.tool));
  const hasLedgerCoverage = toolLedger.some((e) => coversThisOp(e) && toolAppliesTo(e.tool, opProtocol));
  const nothingExercised = toolFindings.toolsRun.length === 0 || toolFindings.worstSeverity === 'UNTESTED';
  if (nothingExercised && !hasLedgerCoverage) return { executionCoverage: 'not-tested', executionCoverageReason: 'no tool exercised this operation' };
  const gapReason = (e: CoverageLedgerEntry): string => {
    if (untestedForOp(e.tool)) return `${e.tool} (untested-for-op)`;
    if (e.status === 'ran') return `${e.tool} (not-examined-for-${opProtocol})`;
    return `${e.tool} (${e.reason ?? 'unknown'})`;
  };
  const applicableGaps = toolLedger
    .filter((e) => !coversThisOp(e) && e.reason !== 'not-applicable-protocol' && toolAppliesTo(e.tool, opProtocol))
    .sort((a, b) => byCodeUnit(a.tool, b.tool));
  if (applicableGaps.length === 0) return { executionCoverage: 'tested' };
  return { executionCoverage: 'partially-tested', executionCoverageReason: applicableGaps.map(gapReason).join(', ') };
}

/** The canonical inputs of `deriveExecutionCoverage`: an operation's known rows and the run's tool records. */
export function executionCoverageFor(op: Pick<Operation, 'protocol' | 'tools'>, tools: VerificationTools): ExecutionCoverage {
  const byTool: CoverageToolFindings['byTool'] = {};
  for (const row of op.tools) {
    if (row.disposition === 'planned' && row.cardinality === 'known') byTool[row.tool] = { severity: row.severity, classifications: row.classifications };
  }
  const toolsRun = Object.keys(byTool);
  const worstSeverity = mergeSeverityLevels(toolsRun.map((t) => byTool[t]?.severity ?? 'UNTESTED'));
  // A not-selected tool is outside the selected verification scope: never a coverage gap (spec-scope §2.4, D3.1).
  const ledger: CoverageLedgerEntry[] = [];
  for (const t of tools) {
    if (t.status === 'not-selected') continue;
    ledger.push(t.status === 'ran' ? { tool: t.tool, status: 'ran', examinedProtocols: t.examinedProtocols } : { tool: t.tool, status: t.status, reason: t.reason });
  }
  return deriveExecutionCoverage({ toolsRun, worstSeverity, byTool }, ledger, op.protocol);
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, CLEAN: 4, UNTESTED: 5 };

/** Worst of a set of levels where UNTESTED dominates CLEAN: a clean tool never masks an untested one; a finding wins. */
export function mergeSeverityLevels(levels: readonly EnvelopeSeverityLevel[]): EnvelopeSeverityLevel {
  let worst: EnvelopeSeverityLevel = 'CLEAN';
  let hasUntested = false;
  for (const level of levels) {
    if (level === 'UNTESTED') hasUntested = true;
    else if ((SEVERITY_RANK[level] ?? 99) < (SEVERITY_RANK[worst] ?? 99)) worst = level;
  }
  return worst === 'CLEAN' && (hasUntested || levels.length === 0) ? 'UNTESTED' : worst;
}

// ── Verdict-level derivations (spec §9.3, §9.4) ─────────────────────────────────────────────────────

/**
 * §9.3: the run is incomplete when it is degraded or empty, its scope is not enumerable, a selected and
 * applicable tool is unavailable, a ran tool left units untested, or a planned row has unknown cardinality.
 * Excluded and not-selected rows never count.
 */
export function verdictIncomplete(r: {
  scope: Pick<DinoResultV1['scope'], 'scopeState'>;
  verification: Pick<DinoResultV1['verification'], 'tools'>;
  operations: readonly Pick<Operation, 'tools'>[];
  degraded: boolean;
  emptyRun: boolean;
}): boolean {
  if (r.degraded || r.emptyRun || r.scope.scopeState === 'UNKNOWN') return true;
  for (const t of r.verification.tools) {
    if (t.status === 'unavailable' || (t.status === 'ran' && t.ledger.notTested > 0)) return true;
  }
  return r.operations.some((op) => op.tools.some((row) => row.disposition === 'planned' && row.cardinality === 'unknown'));
}

/**
 * A tool the run executed: ran, unavailable, or excluded only for its protocol — the pipeline still runs a
 * protocol-inapplicable tool and it produces an empty envelope (Codex review). `requires-roles` and
 * `not-selected` never start.
 */
const executed = (t: VerificationTools[number]): boolean => t.status === 'ran' || t.status === 'unavailable' || (t.status === 'excluded' && t.reason === 'not-applicable-protocol');

/** A record whose tool produced an envelope: completed (ran, unavailable after completing, or protocol-excluded) or crashed. */
const producedEnvelope = (t: VerificationTools[number]): boolean =>
  t.status === 'ran' || (t.status === 'excluded' && t.reason === 'not-applicable-protocol') || (t.status === 'unavailable' && (t.execution === 'completed' || t.execution === 'crashed'));

/** The producer's `degraded`: executed tools exist and none produced an envelope. */
export function verdictDegraded(tools: VerificationTools): boolean {
  const ran = tools.filter(executed);
  return ran.length > 0 && !ran.some(producedEnvelope);
}

/** The producer's `emptyRun`: not degraded, no crash, envelopes exist, and none carries real work (a ran record). */
export function verdictEmptyRun(tools: VerificationTools): boolean {
  const crashed = tools.some((t) => t.status === 'unavailable' && t.execution === 'crashed');
  return !verdictDegraded(tools) && !crashed && tools.some(producedEnvelope) && !tools.some((t) => t.status === 'ran');
}

/** The tools whose requests decide reachability (the producer's `REST_REQUEST_TOOLS`). */
const REST_REQUEST_TOOLS: ReadonlySet<string> = new Set(['rest-fuzzer', 'error-code-validator', 'rate-limit-validator']);

/** An execution that started making requests: it ran, or it was cut off after starting. */
const STARTED: ReadonlySet<string> = new Set(['failed', 'crashed', 'timeout', 'cancelled', 'budget-cut']);
const started = (t: VerificationTools[number]): boolean => t.status === 'ran' || (t.status === 'unavailable' && STARTED.has(t.execution));

/**
 * The run-level unreachable flag (the producer's `computeTargetUnreachable`, INV-6): true exactly when at
 * least one REST-request tool started and every one that started ran to a verdict of unreachable — a REST
 * tool cut off after starting (crash, cancel, timeout, budget) is attempted evidence against it (Codex review).
 */
export function runTargetUnreachable(tools: VerificationTools): boolean {
  const attempted = tools.filter((t) => REST_REQUEST_TOOLS.has(t.tool) && started(t));
  return attempted.length > 0 && attempted.every((t) => t.status === 'ran' && t.targetUnreachable);
}

/**
 * Every verdict reason is a derived claim (Codex review): the degradation rules over the stored tool
 * records — a degraded run is ALL_TOOLS_FAILED unless every selected tool was budget-cut (then
 * PARTIAL_COVERAGE); otherwise any failed tool is PARTIAL_TOOL_FAILURE and any budget-cut tool is
 * PARTIAL_COVERAGE — plus the exact pairings for EMPTY_RUN, TARGET_UNREACHABLE, SCOPE_UNKNOWN and RESULT_TRIMMED.
 */
export function verdictReasons(r: {
  degraded: boolean;
  emptyRun: boolean;
  scope: Pick<DinoResultV1['scope'], 'scopeState'>;
  verification: Pick<DinoResultV1['verification'], 'tools' | 'targetUnreachable'>;
  provenance: Pick<DinoResultV1['provenance'], 'trimmed'>;
}): DinoResultV1['verdict']['reasons'] {
  const ran = r.verification.tools.filter(executed);
  // The degradation owner's failure statuses: FAILED, TIMEOUT, CRASHED (`tool-failed`) and CANCELLED (`run-cancelled`).
  const failed = ran.filter((t) => t.status === 'unavailable' && (t.reason === 'tool-failed' || t.reason === 'run-cancelled'));
  const budgetCut = ran.filter((t) => t.status === 'unavailable' && t.reason === 'budget-cut');
  const reasons: DinoResultV1['verdict']['reasons'][number][] = [];
  if (r.degraded) reasons.push(budgetCut.length > 0 && budgetCut.length === ran.length ? 'PARTIAL_COVERAGE' : 'ALL_TOOLS_FAILED');
  if (r.emptyRun) reasons.push('EMPTY_RUN');
  if (!r.degraded && failed.length > 0) reasons.push('PARTIAL_TOOL_FAILURE');
  if (!r.degraded && budgetCut.length > 0) reasons.push('PARTIAL_COVERAGE');
  if (r.verification.targetUnreachable) reasons.push('TARGET_UNREACHABLE');
  if (r.scope.scopeState === 'UNKNOWN') reasons.push('SCOPE_UNKNOWN');
  if (r.provenance.trimmed.length > 0) reasons.push('RESULT_TRIMMED');
  return [...new Set(reasons)].sort(byCodeUnit);
}

/**
 * verification-completeness-v1 (`calculateVerificationConfidence`): over the selected, applicable tools,
 * the mean of adjudicated / total for each tool that ran with a unit and non-empty accounting; every
 * other selected tool contributes 0; no selected tool at all is 0.
 */
export function verificationCompleteness(tools: VerificationTools): number {
  const selected = tools.filter((t) => t.status === 'ran' || t.status === 'unavailable');
  if (selected.length === 0) return 0;
  const sum = selected.reduce((acc, t) => {
    if (t.status !== 'ran' || t.unit === null) return acc;
    const total = t.ledger.passed + t.ledger.failed + t.ledger.notTested;
    return total === 0 ? acc : acc + (t.ledger.passed + t.ledger.failed) / total;
  }, 0);
  return sum / selected.length;
}
