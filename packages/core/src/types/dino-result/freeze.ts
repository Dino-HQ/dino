// packages/core/src/types/dino-result/freeze.ts

/**
 * Complete JSON-tree freeze with no depth limit (review C‑12): every object and array reachable
 * from `tree` is frozen. Iterative, so a deeply nested OpenAPI schema cannot overflow the stack.
 * The tenant snapshot's bounded `deepFreeze` is a different tool for a different invariant.
 */
export function freezeDeep<T>(tree: T): T {
  const stack: unknown[] = [tree];
  // Visited tracking is separate from frozen-ness: an already-frozen container still has its descendants walked.
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const child of children) if (child !== null && typeof child === 'object') stack.push(child);
  }
  return tree;
}
