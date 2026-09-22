/**
 * Permanent exit-code contract (#2173, output-observability-contract.md §5A.7), relocated from
 * `@dino/cli` so the shared engine can derive a result's exit code (spec §9.4, review C‑3/L3).
 * `@dino/cli` re-exports these names unchanged.
 */

export type OutcomeKind =
  | 'clean'
  | 'findings_below'
  | 'policy'
  | 'partial'
  | 'transient'
  | 'usage'
  | 'config'
  | 'crash';

/** The part of a runtime outcome the exit code depends on. */
export interface ExitOutcome {
  kind: OutcomeKind;
  /** Concurrent kinds; highest-precedence kind wins (INV precedence). */
  also?: readonly OutcomeKind[] | undefined;
  /** `--accept-partial` downgrades a winning `partial` to exit 0 (INV-1). */
  acceptPartial?: boolean | undefined;
}

/** Highest precedence first: crash wins over everything. Frozen: the decision reads this table (Codex review). */
export const OUTCOME_PRECEDENCE: readonly OutcomeKind[] = Object.freeze([
  'crash',
  'config',
  'usage',
  'transient',
  'policy',
  'partial',
  'clean',
  'findings_below',
] as const);

/** The contract exit code per outcome kind (§5A.7) — the frozen table every decision reads. */
const EXIT_CODE_TABLE: Readonly<Record<OutcomeKind, number>> = Object.freeze({
  clean: 0,
  findings_below: 0,
  policy: 3,
  partial: 6,
  transient: 4,
  usage: 2,
  config: 5,
  crash: 70,
});

/** Read-only view of the table for the CLI schema and contract tests; no decision reads it. */
export const EXIT_CODE: ReadonlyMap<OutcomeKind, number> = new Map(Object.entries(EXIT_CODE_TABLE) as [OutcomeKind, number][]);

export function winningKind(o: ExitOutcome): OutcomeKind {
  const kinds = [o.kind, ...(o.also ?? [])];
  let best = kinds[0] ?? 'clean';
  let bestRank = OUTCOME_PRECEDENCE.indexOf(best);
  for (const k of kinds) {
    const rank = OUTCOME_PRECEDENCE.indexOf(k);
    if (rank >= 0 && (bestRank < 0 || rank < bestRank)) {
      best = k;
      bestRank = rank;
    }
  }
  return best;
}

/** Pure: outcome → contract exit code (§5A.7). */
export function resolveExitCode(o: ExitOutcome): number {
  const winner = winningKind(o);
  if (winner === 'partial' && o.acceptPartial === true) return 0;
  return EXIT_CODE_TABLE[winner] ?? 70;
}
