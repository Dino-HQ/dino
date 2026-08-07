/**
 * Endpoint URL validation — SSRF prevention helpers for tenant config loading.
 *
 * Validates that endpoint URLs are not pointing to private, reserved, loopback,
 * cloud metadata, or link-local addresses. Includes DNS rebinding protection.
 *
 * Extracted from tenant-loader.ts to stay under the 400-line limit.
 */

import { promises as dns } from 'node:dns';
import { isIPv4 } from 'node:net';
import { isBlockedIPv4, parseIPv4Octets } from './endpoint-validator-ipv4';
import {
  extractEmbeddedIPv4,
  ipv6ToBytes,
  isBlockedIPv6,
  isIpv6LiteralUnparseable,
} from './endpoint-validator-ipv6';

export { extractEmbeddedIPv4, ipv6ToBytes, isBlockedIPv4, parseIPv4Octets };

/** Convert IPv6 hex-pair suffix (e.g. "a9fe:a9fe") to dotted IPv4 ("169.254.169.254"). */
function hexPairsToIPv4(hex: string): string | null {
  const parts = hex.split(':');
  if (parts.length !== 2) return null;
  const p0 = parts[0];
  const p1 = parts[1];
  if (p0 === undefined || p1 === undefined) return null;
  const hi = Number.parseInt(p0, 16);
  const lo = Number.parseInt(p1, 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

const V4_MAPPED_RE = /^::ffff:(.+)$/i;

/** Resolve IPv4-mapped IPv6 or hex-encoded hostnames to plain IPv4. */
function resolveToIPv4(hostname: string): string | null {
  const v4Mapped = V4_MAPPED_RE.exec(hostname);
  if (v4Mapped) {
    const mapped = v4Mapped[1];
    if (mapped === undefined) return null;
    if (isIPv4(mapped)) return mapped;
    const decoded = hexPairsToIPv4(mapped);
    if (!decoded) return null;
    return decoded;
  }
  return hostname;
}

const BLOCKED_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.internal.',
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- NOSONAR: intentional metadata endpoint blocklist
  'fd00:ec2::254',
]);

export type EndpointRejectReason =
  | 'malformed_url'
  | 'wrong_protocol'
  | 'blocked_ipv6'
  | 'metadata_host'
  | 'blocked_ipv4'
  | 'unparseable_mapped_ip';

export type EndpointCheckResult =
  | { allowed: true }
  | { allowed: false; reason: EndpointRejectReason };

export type DNSValidationResult =
  | { allowed: true; resolvedIP: string }
  | { allowed: false; reason: EndpointRejectReason | 'dns_resolution_failed' };

export const ENDPOINT_REJECT_MESSAGES: Record<
  EndpointRejectReason | 'dns_resolution_failed',
  string
> = {
  malformed_url: 'Endpoint URL is malformed',
  wrong_protocol: 'Endpoint URL must use http:// or https://',
  blocked_ipv6:
    'Endpoint URL points to a blocked IPv6 address (loopback, link-local, unique-local, or transition form)',
  metadata_host: 'Endpoint URL points to a cloud metadata service',
  blocked_ipv4: 'Endpoint URL points to a private, reserved, or loopback IPv4 address',
  unparseable_mapped_ip: 'Endpoint URL contains an unparseable IPv4-mapped IPv6 address',
  dns_resolution_failed: 'Endpoint hostname could not be resolved via DNS',
};

export function checkEndpointUrl(url: string): EndpointCheckResult {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { allowed: false, reason: 'wrong_protocol' };
    }

    let hostname = parsed.hostname;
    while (hostname.endsWith('.')) hostname = hostname.slice(0, -1);

    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }

    if (isBlockedIPv6(hostname)) return { allowed: false, reason: 'blocked_ipv6' };

    if (isIpv6LiteralUnparseable(hostname)) {
      return { allowed: false, reason: 'malformed_url' };
    }

    if (BLOCKED_METADATA_HOSTS.has(hostname) || BLOCKED_METADATA_HOSTS.has(`${hostname}.`)) {
      return { allowed: false, reason: 'metadata_host' };
    }

    const resolved = resolveToIPv4(hostname);
    if (resolved === null) return { allowed: false, reason: 'unparseable_mapped_ip' };

    if (isIPv4(resolved)) {
      const octets = parseIPv4Octets(resolved);
      if (octets && isBlockedIPv4(octets)) return { allowed: false, reason: 'blocked_ipv4' };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'malformed_url' };
  }
}

/** Validate endpoint URL is http(s) and not a cloud metadata or private-range endpoint. */
export function isAllowedEndpointUrl(url: string): boolean {
  return checkEndpointUrl(url).allowed;
}

type DNSResolver = {
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6?: (hostname: string) => Promise<string[]>;
};

async function withDnsTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS resolution timeout')), timeoutMs); // determinism:seam
  });
  try {
    return await Promise.race([promise, timeoutError]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHostnameForDnsLookup(parsed: URL): string {
  let hostname = parsed.hostname;
  while (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  return hostname;
}

async function resolveHostnameViaDns(hostname: string, resolve: DNSResolver): Promise<string[]> {
  const DNS_TIMEOUT_MS = 5_000;
  let ips: string[] | undefined;
  try {
    ips = await withDnsTimeout(resolve.resolve4(hostname), DNS_TIMEOUT_MS);
  } catch {
    // masked-fix:allowed — IPv4 DNS failure is an expected outcome for invalid/unreachable
    // hosts. The caller reports it once as `dns_resolution_failed`; the underlying resolver
    // message (e.g. "queryA ENOTFOUND") is redundant jargon, so no raw console noise (#2143).
    ips = undefined;
  }
  if ((ips === undefined || ips.length === 0) && resolve.resolve6) {
    try {
      ips = await withDnsTimeout(resolve.resolve6(hostname), DNS_TIMEOUT_MS);
    } catch {
      // masked-fix:allowed — IPv6 DNS failure is likewise expected; surfaced once by the
      // caller as `dns_resolution_failed` (#2143).
      ips = undefined;
    }
  }
  return ips ?? [];
}

function validateDnsResolvedIpList(ips: string[]): DNSValidationResult {
  for (const ip of ips) {
    if (isBlockedIPv6(ip)) return { allowed: false, reason: 'blocked_ipv6' };
    if (isIpv6LiteralUnparseable(ip)) return { allowed: false, reason: 'malformed_url' };
    const resolved = resolveToIPv4(ip);
    if (resolved === null) return { allowed: false, reason: 'unparseable_mapped_ip' };
    if (isIPv4(resolved)) {
      const octets = parseIPv4Octets(resolved);
      if (octets && isBlockedIPv4(octets)) {
        return { allowed: false, reason: 'blocked_ipv4' };
      }
    }
  }
  const firstIp = ips[0];
  if (firstIp === undefined)
    throw new Error('validateDnsResolvedIpList called with empty ips array');
  return { allowed: true, resolvedIP: firstIp };
}

/**
 * Runtime DNS validation to prevent DNS rebinding SSRF bypasses (#870).
 * Should be called immediately before making outbound HTTP requests.
 */
export async function resolveAndValidateDNS(
  url: string,
  resolver?: DNSResolver,
): Promise<DNSValidationResult> {
  const staticCheck = checkEndpointUrl(url);
  if (!staticCheck.allowed) return staticCheck;

  const parsed = new URL(url);
  const hostname = normalizeHostnameForDnsLookup(parsed);

  if (hostname.includes(':')) {
    return { allowed: true, resolvedIP: hostname };
  }
  if (isIPv4(hostname)) {
    return { allowed: true, resolvedIP: hostname };
  }

  const resolve = resolver ?? dns;
  const ips = await resolveHostnameViaDns(hostname, resolve);

  if (ips.length === 0) {
    return { allowed: false, reason: 'dns_resolution_failed' };
  }

  return validateDnsResolvedIpList(ips);
}
