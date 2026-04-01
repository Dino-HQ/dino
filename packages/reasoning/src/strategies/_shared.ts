/**
 * Shared structural type for strategy options.
 *
 * Internal only — NOT re-exported from the package index.
 *
 * CondensedReport is defined in the host layer (src/orchestration/).
 * We accept it as a structural type here to avoid cross-layer imports.
 * The caller (host) passes the concrete CondensedReport object.
 */

/**
 * Structural type for the report parameter accepted by all strategy options.
 * Mirrors CondensedReport without importing from src/orchestration/ (dependency direction).
 */
export interface StrategyReportInput {
  runId: string;
  tenantId: string;
  environment: string;
  aggregate: {
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    overallSeverity: string;
  };
  envelopes: ReadonlyArray<{
    toolName: string;
    severity: string;
    numericScore: number;
    total: number;
    passed: number;
    failed: number;
    findings: ReadonlyArray<{
      classification: string;
      normalizedLevel: string;
      count: number;
      examples: readonly string[];
    }>;
  }>;
  truncated: boolean;
}
