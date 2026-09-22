/**
 * @dino/core — Result Envelope Types
 *
 * Standard wrapper for all agent tool results. Every tool returns a
 * ResultEnvelope so the aggregation layer can score and reason about
 * findings uniformly.
 */

/** Severity level classifications */
export type SeverityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/**
 * Overall envelope severity (includes CLEAN for zero-finding results, UNTESTED for empty/degraded runs).
 * Any switch/case on this type MUST handle 'UNTESTED' — it signals a run where nothing executed.
 */
export type EnvelopeSeverityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAN' | 'UNTESTED';

export interface ResultEnvelope<T = unknown> {
  /** Which agent produced this result (e.g., 'api-agent') */
  agentId: string;

  /** Which tool within the agent (e.g., 'input-fuzzer') */
  toolName: string;

  /** ISO 8601 timestamp of when the tool finished */
  timestamp: string;

  /** Environment the tool ran against (e.g., 'qa', 'sandbox') */
  environment: string;

  /** Cumulative execution time in milliseconds (sum of individual entry durations) */
  durationMs: number;

  /** Computed severity score for this result */
  severity: SeverityScore;

  /** Quick numeric summary of pass/fail counts */
  summary: EnvelopeSummary;

  /** Distinct, code-point-sorted operation keys this tool exercised this scan
      (PER_OP_FINDINGS on). Same key namespace as SeverityFinding.operation.
      Present (possibly []) iff the flag is on; absent on the legacy shape and on
      crash envelopes. Survives stripRawResults — the cloud persists it to
      scan_operation_coverage (Spec 3, task #13). */
  operationsExercised?: string[];

  /** Count of operations/units this tool INSPECTED this scan (work done). Distinct from
      summary.total, which is the verdict ledger (passed + failed + notTested). The ledger reads this so a completed
      tool that examined >=1 unit reads `ran` even with 0 findings. Absent ⇒ ledger falls back
      to summary.total. */
  examinedOperations?: number;

  /** Protocols this tool actually examined this scan (#2319). Set by `both`-protocol tools that
      examine protocols asymmetrically (e.g. deprecation-tracker: static REST always, live GraphQL
      only when resolvers are wired). Execution coverage credits an op only for a protocol the tool
      examined. Absent ⇒ the tool covers every protocol it applies to (legacy behavior). */
  examinedProtocols?: Array<'graphql' | 'rest'>;

  /** The raw, tool-specific result payload */
  rawResult: T;

  /**
   * Set by the runner when the tool executor threw an unhandled exception.
   * Presence (non-undefined) means crash path. Absence means normal completion.
   * Agent wrappers may include this field, but runTool scrubs it on the success
   * path — only values written by the runner catch block are trusted.
   */
  readonly crashReason?: string | undefined;
}

/** Why a verification unit got no verdict (#2388 Verdict Ledger). Closed enum; `unknown` is the
 *  catch-all. The runtime array is the single source of truth — the ledger primitive rejects any
 *  `notTestedByReason` key not in this set, so the "closed enum" holds at runtime, not just in types. */
export const NOT_TESTED_REASONS = [
  'authUnavailable',
  'unreachable',
  'timeout',
  'budgetExceeded',
  'aborted',
  'unsupported',
  'dryRun',
  'inconclusive',
  'dependencyUnavailable',
  'unknown',
  'withheldUnsafe',
] as const;
export type NotTestedReason = (typeof NOT_TESTED_REASONS)[number];

/** What one ledger cell counts (declared per tool so aggregates never sum incompatible units). */
export const VERIFICATION_UNITS = [
  'operation',
  'operation-auth-state',
  'operation-strategy',
  'test-case',
  'schema-element',
] as const;
export type VerificationUnit = (typeof VERIFICATION_UNITS)[number];

export type NotTestedByReason = Partial<Record<NotTestedReason, number>>;

/**
 * Verdict ledger (#2388): every in-scope verification unit gets exactly ONE terminal outcome —
 * passed, failed, or notTested — so `total === passed + failed + notTested` and
 * `notTested === Σ notTestedByReason`. Derived by the engine primitive from a tool's ToolOutcome
 * (#2388 B8-D: the primitive accepts no other builder shape).
 */
export interface EnvelopeSummary {
  /** Verification units in scope for this tool (passed + failed + notTested once migrated). */
  total: number;

  /** Units with a passing verdict (per-entry outcome counters only, never a findings count). */
  passed: number;

  /** Units with a failing verdict (per-entry outcome counters only, never by subtraction). */
  failed: number;

  /** Units in scope that reached NO verdict (dry-run, timeout, unreachable, budget, …). A
      coverage gap is never a pass: notTested > 0 with no findings ⇒ severity UNTESTED.
      Absent ⇒ 0. Units are tool-local (see `unit`) — never sum across tools. */
  notTested?: number;

  /** Breakdown of `notTested` by terminal reason; Σ values === notTested. A key is present only
      with a positive count (never as a zero-valued tag). Present once the producer is ledger-migrated. */
  notTestedByReason?: NotTestedByReason;

  /** The unit every counter above is expressed in. Present once the producing tool declares it. */
  unit?: VerificationUnit;

  /** Number of findings normalized as CRITICAL (derived from severity.findings) */
  critical: number;
}

export interface SeverityScore {
  /** Overall severity level for this envelope */
  level: EnvelopeSeverityLevel;

  /**
   * Numeric score 0-100, higher = worse.
   * Formula: sum(WEIGHT[level] * count), clamped 0-100.
   * Weights: CRITICAL=25, HIGH=10, MEDIUM=3, LOW=1, INFO=0.
   */
  numericScore: number;

  /** Individual findings that contributed to the score */
  findings: SeverityFinding[];
}

export interface SeverityFinding {
  /** Original tool-specific classification (e.g., 'DATA_LEAK', 'SCHEMA_MISMATCH') */
  classification: string;

  /** Operation key this finding was observed on (PER_OP_FINDINGS grouping).
      REST: "{METHOD} {path}" · GraphQL: operation name · type-level: "{Type}.{field}".
      Absent when grouping is per-classification (flag off), when the entry has no
      derivable operation, and on TOOL_CRASH findings — absent means the finding is
      never auto-resolved downstream (INV-C, fail-closed). */
  operation?: string;

  /** Normalized severity level */
  normalizedLevel: SeverityLevel;

  /** How many times this finding occurred */
  count: number;

  /** Up to 3 example descriptions */
  examples: string[];
}
