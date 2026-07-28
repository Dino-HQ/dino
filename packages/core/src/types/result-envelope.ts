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

export interface EnvelopeSummary {
  /** Total number of items tested/checked */
  total: number;

  /** Number that passed */
  passed: number;

  /** Number that failed */
  failed: number;

  /** Items in scope but NOT exercised (partial/budget-cut scan). Additive/informational —
      does NOT change total/passed/failed. Absent ⇒ 0 (complete scan).
      UNIT IS TOOL-LOCAL and NOT comparable across tools: rest-fuzzer counts whole operations,
      rbac-matrix counts op×role iterations. Treat it as a per-envelope "how incomplete" magnitude /
      binary incompleteness flag, never as a cross-tool total. */
  notTested?: number;

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
