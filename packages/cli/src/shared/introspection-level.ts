/**
 * #202 — guarded read of discovery fidelity from plugin raw payload.
 */

export type ScanIntrospectionLevel = 'full' | 'shallow' | 'minimal';

export type ScanStructureSource = 'live' | 'sdl';

/** Mirror of notifyReducedFidelity's guarded string read - typed for report assembly. */
export function readIntrospectionLevel(raw: unknown): ScanIntrospectionLevel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const level = Reflect.get(raw, 'introspectionLevel');
  if (level === 'full' || level === 'shallow' || level === 'minimal') return level;
  return undefined;
}

/** #2306 - structure provenance from discovery raw payload. */
export function readStructureSource(raw: unknown): ScanStructureSource | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = Reflect.get(raw, 'structureSource');
  if (source === 'live' || source === 'sdl') return source;
  return undefined;
}

export type DiscoveryRead = 'introspection' | 'sdl' | 'openapi';

/**
 * The discovery sources this host read, declared to the engine's Scope Identity (Cleanup V2 task 3). One
 * plugin runs per target: a GraphQL discovery carries its `structureSource` (live introspection or SDL); a
 * REST discovery is the OpenAPI plugin's (a discovery with zero operations never reaches the pipeline —
 * `discoverOperationsDetailed` throws). The engine digests the material; hosts never compute identity.
 */
export function discoveryRead(input: { structureSource: ScanStructureSource | undefined; hasRest: boolean }): DiscoveryRead[] {
  const read: DiscoveryRead[] = [];
  if (input.structureSource !== undefined) read.push(input.structureSource === 'sdl' ? 'sdl' : 'introspection');
  if (input.hasRest) read.push('openapi');
  return read;
}

/** #202 / #2306: discovery fidelity + structure provenance from plugin raw payload. */
export function readDiscoveryProvenance(raw: unknown): {
  introspectionLevel: ScanIntrospectionLevel | undefined;
  structureSource: ScanStructureSource | undefined;
} {
  return {
    introspectionLevel: readIntrospectionLevel(raw),
    structureSource: readStructureSource(raw),
  };
}
