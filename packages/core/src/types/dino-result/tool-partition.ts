/**
 * The completed / failed partition of a `DinoResult`'s verification records (Cleanup V2 task 4c): the
 * one owner of the legacy `toolsCompleted` / `toolsFailed` semantics, mirroring the engine's bookkeeping.
 * A tool completed when it ran, ran without applicable work (`excluded: not-applicable-protocol`) or
 * completed with nothing to adjudicate (`unavailable` with `execution: 'completed'`); it failed when its
 * execution failed, timed out, crashed (`tool-failed`) or was cancelled (`run-cancelled`). Budget cuts,
 * circuit-breaker skips and unselected tools are in neither list.
 */
import type { DinoResult } from './v1';

export type VerificationToolRecord = DinoResult['verification']['tools'][number];

export const toolCompleted = (t: VerificationToolRecord): boolean =>
  t.status === 'ran' || (t.status === 'excluded' && t.reason === 'not-applicable-protocol') || (t.status === 'unavailable' && t.execution === 'completed');

export const toolFailed = (t: VerificationToolRecord): boolean =>
  t.status === 'unavailable' && (t.reason === 'tool-failed' || t.reason === 'run-cancelled');

export function partitionTools(tools: readonly VerificationToolRecord[]): { completed: VerificationToolRecord['tool'][]; failed: VerificationToolRecord['tool'][] } {
  return { completed: tools.filter(toolCompleted).map((t) => t.tool), failed: tools.filter(toolFailed).map((t) => t.tool) };
}
