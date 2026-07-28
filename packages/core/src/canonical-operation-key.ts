/**
 * Normalize REST method + path into a canonical operation key (#1277, HC #37).
 */

export function canonicalOperationKey(method: string, path: string): string {
  const mRaw = method.trim();
  const pRaw = path.trim();
  const m = (mRaw === '' ? 'GET' : mRaw).toUpperCase();
  const p = (pRaw === '' ? '/' : pRaw).replaceAll(/\/[0-9a-f-]{8,}/gi, '/{id}');
  return `${m} ${p}`;
}

/**
 * The SINGLE operation identity used to key RBAC expectations (#1860 / B6).
 *
 * The expectation matrix must be authored (console / tenant YAML), persisted, and looked up by the
 * agent under ONE key, or every cell silently misses → UNKNOWN → a false "all clear". REST keys by
 * the canonical `${METHOD} ${path}` (matching the persisted `apiOperations.operationKey`); GraphQL
 * has no method/path, so it keys by the operation name (which is also its persisted operationKey).
 * Used by BOTH `rbac-matrix`'s `getExpectation` lookup and the console authoring surface.
 */
export function operationExpectationKey(op: {
  name: string;
  method?: string | undefined;
  path?: string | undefined;
}): string {
  if (op.method !== undefined && op.path !== undefined) {
    return canonicalOperationKey(op.method, op.path);
  }
  return op.name;
}
