import type { PlanUnitId } from './types/workload-plan';

/** Length prefixes preserve tuple boundaries even for arbitrary target names. */
export function planUnitId(parts: readonly string[]): PlanUnitId {
  return parts.map((part) => `${part.length}:${part}`).join('');
}
