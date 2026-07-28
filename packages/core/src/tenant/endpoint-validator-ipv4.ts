/**
 * IPv4 parsing and blocking for endpoint URL validation (#850, #851, #858).
 */

/** Order matches prior sequential `if` ladder (first match wins). #850, #851, #858. */
const IPV4_PRIVATE_OR_RESERVED_PREDICATES: ReadonlyArray<
  (a: number, b: number, c: number) => boolean
> = [
  (a, b) => a === 169 && b === 254,
  (a) => a === 127,
  (a) => a === 10,
  (a, b) => a === 172 && b >= 16 && b <= 31,
  (a, b) => a === 192 && b === 168,
  (a, b) => a === 100 && b >= 64 && b <= 127,
  (a, b, c) => a === 192 && b === 0 && c === 2,
  (a, b, c) => a === 198 && b === 51 && c === 100,
  (a, b, c) => a === 203 && b === 0 && c === 113,
  (a, b) => a === 198 && (b === 18 || b === 19),
];

function isIpv4PrivateOrReservedRange(a: number, b: number, c: number): boolean {
  return IPV4_PRIVATE_OR_RESERVED_PREDICATES.some((predicate) => predicate(a, b, c));
}

export function parseIPv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : Number.NaN;
  });
  if (octets.some(Number.isNaN)) return null;
  return octets;
}

export function isBlockedIPv4(octets: number[]): boolean {
  const a = octets[0];
  const b = octets[1];
  const c = octets[2];
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0) return true;
  if (isIpv4PrivateOrReservedRange(a, b, c)) return true;
  if (a >= 240) return true;
  return false;
}
