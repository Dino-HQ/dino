/**
 * The canonical finding mass of a result: Σ `findings[].count` (Cleanup V2 task 4c). A finding row
 * groups occurrences, so the row count is not a finding count; every host surface reads this one sum.
 */
export function findingMass(findings: readonly { count: number }[]): number {
  return findings.reduce((total, finding) => total + finding.count, 0);
}
