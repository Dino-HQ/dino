/**
 * Exhaustive switch guard — forces compile errors when new union members
 * are added but not handled in switch/if-else chains.
 *
 * Place in the `default:` case of any switch over a discriminated union.
 * If all cases are handled, TypeScript narrows the value to `never` and
 * the call type-checks. If a new member is added to the union without
 * updating the switch, the value won't narrow to `never` → compile error.
 *
 * The optional `context` parameter makes runtime failures debuggable
 * without stack traces (e.g. "Unhandled case: pending — context: auditAction").
 */
export function assertNever(value: never, context?: string): never {
  const suffix = context !== undefined ? ` — context: ${context}` : '';
  throw new Error(`Unhandled case: ${String(value)}${suffix}`);
}
