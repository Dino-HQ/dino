/**
 * #202 — guarded read of discovery fidelity from plugin raw payload.
 */

export type ScanIntrospectionLevel = 'full' | 'shallow' | 'minimal';

/** Mirror of notifyReducedFidelity's guarded string read - typed for report assembly. */
export function readIntrospectionLevel(raw: unknown): ScanIntrospectionLevel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const level = Reflect.get(raw, 'introspectionLevel');
  if (level === 'full' || level === 'shallow' || level === 'minimal') return level;
  return undefined;
}
