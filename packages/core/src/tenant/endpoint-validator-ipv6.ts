/**
 * IPv6 transition-form decode + blanket prefix block (#1852).
 * Split from endpoint-validator.ts to stay under the 400-line file cap.
 */

import { isBlockedIPv4, parseIPv4Octets } from './endpoint-validator-ipv4';

function byteAt(bytes: Uint8Array, index: number): number {
  return bytes.at(index) ?? 0;
}

function bytesAllZero(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (byteAt(bytes, i) !== 0) return false;
  }
  return true;
}

function bytesToDottedIpv4(bytes: Uint8Array): string {
  return `${byteAt(bytes, 12)}.${byteAt(bytes, 13)}.${byteAt(bytes, 14)}.${byteAt(bytes, 15)}`;
}

function bytesToDottedIpv4FromOffset(bytes: Uint8Array, offset: number): string {
  return `${byteAt(bytes, offset)}.${byteAt(bytes, offset + 1)}.${byteAt(bytes, offset + 2)}.${byteAt(bytes, offset + 3)}`;
}

function parseHextetGroup(part: string): number[] | null {
  if (part.length === 0) return [];
  const out: number[] = [];
  for (const token of part.split(':')) {
    if (token.length === 0 || token.length > 4) return null;
    const n = Number.parseInt(token, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    out.push(n);
  }
  return out;
}

function tryParseTrailingDottedQuad(host: string): { core: string; v4: number[] | null } {
  const dcIdx = host.indexOf('::');
  if (dcIdx !== -1) {
    const afterDc = host.slice(dcIdx + 2);
    if (afterDc.length > 0 && afterDc.includes('.')) {
      const octets = parseIPv4Octets(afterDc);
      if (octets) return { core: host.slice(0, dcIdx + 2), v4: octets };
    }
  }
  const lastColon = host.lastIndexOf(':');
  if (lastColon > 0 && host[lastColon - 1] !== ':') {
    const tail = host.slice(lastColon + 1);
    if (tail.includes('.')) {
      const octets = parseIPv4Octets(tail);
      if (octets) return { core: host.slice(0, lastColon), v4: octets };
    }
  }
  return { core: host, v4: null };
}

function expandIpv6Hextets(core: string): { left: number[]; right: number[] } | null {
  const dcIndex = core.indexOf('::');
  if (dcIndex !== -1) {
    const halves = core.split('::');
    if (halves.length !== 2) return null;
    const leftParsed = parseHextetGroup(halves[0] ?? '');
    const rightParsed = parseHextetGroup(halves[1] ?? '');
    if (leftParsed === null || rightParsed === null) return null;
    return { left: leftParsed, right: rightParsed };
  }
  const parsed = parseHextetGroup(core);
  if (parsed === null) return null;
  return { left: parsed, right: [] };
}

function hextetsToBytePairs(
  left: number[],
  right: number[],
  trailingV4: number[] | null,
  core: string,
): number[] | null {
  const dcIndex = core.indexOf('::');
  const v4Hextets = trailingV4 ? 2 : 0;
  const totalSlots = left.length + right.length + v4Hextets;
  if (totalSlots > 8) return null;

  const zerosNeeded = 8 - totalSlots;
  if (dcIndex === -1 && zerosNeeded !== 0) return null;

  const hextets = [...left, ...Array<number>(zerosNeeded).fill(0), ...right];
  if (hextets.length !== 8 - v4Hextets) return null;

  const pairs: number[] = [];
  for (const h of hextets) {
    pairs.push((h >> 8) & 0xff, h & 0xff);
  }
  while (pairs.length < 12) pairs.push(0);
  if (trailingV4) {
    pairs.push(trailingV4[0] ?? 0, trailingV4[1] ?? 0, trailingV4[2] ?? 0, trailingV4[3] ?? 0);
  } else {
    while (pairs.length < 16) pairs.push(0);
  }
  return pairs;
}

function parseIpv6HextetLayout(core: string, trailingV4: number[] | null): number[] | null {
  const expanded = expandIpv6Hextets(core);
  if (expanded === null) return null;
  return hextetsToBytePairs(expanded.left, expanded.right, trailingV4, core);
}

/** Expand a compressed/literal IPv6 (one `::`, trailing dotted-quad) to 16 bytes; null if malformed. */
export function ipv6ToBytes(hostname: string): Uint8Array | null {
  const lower = hostname.toLowerCase();
  if (lower.includes('%')) return null;

  const { core, v4: trailingV4 } = tryParseTrailingDottedQuad(lower);
  const layout = parseIpv6HextetLayout(core, trailingV4);
  if (layout === null) return null;
  return new Uint8Array(layout);
}

function isNat64LocalBytes(bytes: Uint8Array): boolean {
  return (
    (byteAt(bytes, 0) === 0x00 &&
      byteAt(bytes, 1) === 0x64 &&
      byteAt(bytes, 2) === 0x00 &&
      byteAt(bytes, 3) === 0xff &&
      byteAt(bytes, 4) === 0x00 &&
      byteAt(bytes, 5) === 0x9b &&
      byteAt(bytes, 6) === 0x00 &&
      byteAt(bytes, 7) === 0x01) ||
    (byteAt(bytes, 0) === 0x00 &&
      byteAt(bytes, 1) === 0x64 &&
      byteAt(bytes, 2) === 0xff &&
      byteAt(bytes, 3) === 0x9b &&
      byteAt(bytes, 4) === 0x00 &&
      byteAt(bytes, 5) === 0x01)
  );
}

function isNat64WellKnownBytes(bytes: Uint8Array): boolean {
  if (isNat64LocalBytes(bytes)) return false;
  return (
    (byteAt(bytes, 0) === 0x00 &&
      byteAt(bytes, 1) === 0x64 &&
      byteAt(bytes, 2) === 0x00 &&
      byteAt(bytes, 3) === 0xff &&
      byteAt(bytes, 4) === 0x00 &&
      byteAt(bytes, 5) === 0x9b &&
      bytesAllZero(bytes, 6, 12)) ||
    (byteAt(bytes, 0) === 0x00 &&
      byteAt(bytes, 1) === 0x64 &&
      byteAt(bytes, 2) === 0xff &&
      byteAt(bytes, 3) === 0x9b &&
      bytesAllZero(bytes, 4, 12))
  );
}

/** Return embedded IPv4 from known transition encodings; null for native public IPv6. */
export function extractEmbeddedIPv4(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null;

  if (byteAt(bytes, 0) === 0x20 && byteAt(bytes, 1) === 0x02) {
    return bytesToDottedIpv4FromOffset(bytes, 2);
  }

  const isIsatapOui =
    byteAt(bytes, 9) === 0x00 &&
    byteAt(bytes, 10) === 0x5e &&
    byteAt(bytes, 11) === 0xfe &&
    (byteAt(bytes, 8) === 0x00 || byteAt(bytes, 8) === 0x02);
  if (isIsatapOui) return bytesToDottedIpv4(bytes);

  if (bytesAllZero(bytes, 0, 10) && byteAt(bytes, 10) === 0xff && byteAt(bytes, 11) === 0xff) {
    return bytesToDottedIpv4(bytes);
  }

  if (bytesAllZero(bytes, 0, 12)) return bytesToDottedIpv4(bytes);
  if (isNat64WellKnownBytes(bytes) || isNat64LocalBytes(bytes)) return bytesToDottedIpv4(bytes);

  return null;
}

function isNat64LocalHostname(hostname: string): boolean {
  return /^64:ff9b:1(?::|$)/i.test(hostname);
}

function isNat64WellKnownHostname(hostname: string): boolean {
  if (isNat64LocalHostname(hostname)) return false;
  return /^64:ff9b(?::|$)/i.test(hostname);
}

function isBlockedIPv6TransitionPrefix(bytes: Uint8Array, hostname: string): boolean {
  if (isNat64LocalHostname(hostname) || isNat64WellKnownHostname(hostname)) return true;
  if (bytesAllZero(bytes, 0, 12) && !(byteAt(bytes, 10) === 0xff && byteAt(bytes, 11) === 0xff)) {
    return true;
  }
  if (byteAt(bytes, 0) === 0x20 && byteAt(bytes, 1) === 0x02) return true;
  if (
    byteAt(bytes, 0) === 0x20 &&
    byteAt(bytes, 1) === 0x01 &&
    byteAt(bytes, 2) === 0x00 &&
    byteAt(bytes, 3) === 0x00
  ) {
    return true;
  }
  if (isNat64WellKnownBytes(bytes) || isNat64LocalBytes(bytes)) return true;
  if (byteAt(bytes, 0) === 0xfe && (byteAt(bytes, 1) & 0xc0) === 0xc0) return true;
  if (byteAt(bytes, 0) === 0x01 && byteAt(bytes, 1) === 0x00 && bytesAllZero(bytes, 2, 8))
    return true;
  return false;
}

function embeddedIpv4ForBlockCheck(hostname: string, bytes: Uint8Array): string | null {
  const fromTransition = extractEmbeddedIPv4(bytes);
  if (fromTransition !== null) return fromTransition;

  if (isNat64WellKnownHostname(hostname) || isNat64LocalHostname(hostname)) {
    return bytesToDottedIpv4(bytes);
  }

  const lastColon = hostname.lastIndexOf(':');
  const lastDot = hostname.lastIndexOf('.');
  if (lastColon !== -1 && lastDot > lastColon) return bytesToDottedIpv4(bytes);

  const lower = hostname.toLowerCase();
  if (lower.endsWith(':a9fe:a9fe') || /:5efe:a9fe:a9fe$/.test(lower)) {
    return bytesToDottedIpv4(bytes);
  }

  return null;
}

/** Parse the first 16-bit group of an IPv6 address for CIDR range checks. */
function parseIPv6First16(ipv6: string): number | null {
  const first = ipv6.toLowerCase().split(':')[0];
  if (!first) return null;
  const n = Number.parseInt(first, 16);
  return Number.isNaN(n) ? null : n;
}

/** Block IPv6 loopback, unspecified, link-local, unique-local, and transition forms (#575, #1852). */
export function isBlockedIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  const first16 = parseIPv6First16(normalized);
  if (first16 !== null) {
    if ((first16 & 0xfe00) === 0xfc00) return true;
    if ((first16 & 0xffc0) === 0xfe80) return true;
  }

  const bytes = ipv6ToBytes(hostname);
  if (bytes === null) return false;

  if (isBlockedIPv6TransitionPrefix(bytes, hostname)) return true;

  const embedded = embeddedIpv4ForBlockCheck(hostname, bytes);
  if (embedded !== null) {
    const octets = parseIPv4Octets(embedded);
    if (octets && isBlockedIPv4(octets)) return true;
  }

  return false;
}

export function isIpv6LiteralUnparseable(hostname: string): boolean {
  return hostname.includes(':') && ipv6ToBytes(hostname) === null;
}
