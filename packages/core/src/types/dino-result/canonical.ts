
/** Code-unit ordering — the one comparator every canonical array uses (never the locale, never the default). */
/** The canonical-bytes cap (spec §7, D15): the producer trims toward it and the parser refuses beyond it. */
export const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;

export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
// packages/core/src/types/dino-result/canonical.ts

/** Thrown when a value falls outside the canonical JSON domain (spec §7, review M‑3). */
export class CanonicalDomainError extends Error {
  constructor(message: string, readonly path: string) {
    super(`[dino-result] canonical domain: ${message} at ${path || '$'}`);
    this.name = 'CanonicalDomainError';
  }
}

/** Realm-independent: a plain object's prototype is null or a root prototype whose own prototype is null. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function encodeScalar(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalDomainError(`non-finite number ${String(value)}`, path);
    return JSON.stringify(value);
  }
  throw new CanonicalDomainError(`unsupported value of type ${typeof value}`, path);
}

function encode(value: unknown, path: string, stack: Set<object>): string {
  if (value === null || typeof value !== 'object') return encodeScalar(value, path);
  if (stack.has(value)) throw new CanonicalDomainError('cycle', path);
  stack.add(value);
  let out: string;
  if (Array.isArray(value)) {
    const parts = value.map((item, i) => {
      if (item === undefined) throw new CanonicalDomainError('undefined inside an array', `${path}[${i}]`);
      return encode(item, `${path}[${i}]`, stack);
    });
    out = `[${parts.join(',')}]`;
  } else {
    if (!isPlainObject(value)) throw new CanonicalDomainError('non-plain object', path);
    const keys = Object.keys(value).sort(byCodeUnit);
    const parts: string[] = [];
    for (const key of keys) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue; // omitted, never serialised
      const childPath = `${path}.${key}`;
      parts.push(`${JSON.stringify(key)}:${encode(child, childPath, stack)}`);
    }
    out = `{${parts.join(',')}}`;
  }
  stack.delete(value);
  return out;
}

/**
 * Canonical bytes: JSON, UTF-8, no whitespace, object keys sorted by UTF-16 code unit recursively,
 * arrays in the order given (the constructor sorts them per spec §7), `undefined` properties omitted.
 * Rejects cycles, bigint, symbol, function, non-plain objects, non-finite numbers and `undefined`
 * inside arrays — a signed serialiser must not rely on `JSON.stringify` coercion.
 */
export function canonicalDinoResultBytes(value: unknown): string {
  return encode(value, '', new Set());
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The one Web Crypto capability this module uses.
 *
 * Declared structurally rather than as the ambient Web Crypto global, which only exists when a DOM lib
 * or a recent `@types/node` is in scope. Relying on the global made `@dino/core` compile here (node
 * types 25, which ship `web-globals/crypto.d.ts`) and fail for a consumer on 22 — an undeclared
 * dependency that the release's build-isolation gate caught. `crypto.subtle` satisfies this shape on
 * Node and on Workers alike.
 */
export interface SubtleDigest {
  digest(algorithm: string, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
}

/** SHA-256 of the canonical bytes, hex. Web Crypto so Node and Workers hash identically. */
export async function dinoResultDigest(bytes: string, subtle: SubtleDigest = globalThis.crypto.subtle): Promise<string> {
  const data = new TextEncoder().encode(bytes);
  return toHex(await subtle.digest('SHA-256', data));
}
