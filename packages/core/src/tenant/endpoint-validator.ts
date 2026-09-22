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
import { isBlockedIPv4, isDeveloperReachableIPv4, parseIPv4Octets } from './endpoint-validator-ipv4';
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


/** `::1` is the IPv6 half of loopback — `localhost` resolves to it as often as to 127.0.0.1. */
function isPermittedLoopbackIPv6(ip: string, policy: EndpointPolicyOptions): boolean {
  if (policy.allowPrivateTarget !== true) return false;
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  return bare === '::1' || bare === '0:0:0:0:0:0:0:1';
}

/**
 * Opt-in for scanning a service the operator can reach themselves.
 *
 * `allowPrivateTarget` widens the destination policy to loopback and RFC1918 ONLY — never
 * link-local/metadata, never other reserved ranges. It exists because the SSRF threat is a target
 * URL supplied by SOMEONE ELSE: in the cloud the URL comes from a customer, and fetching
 * 169.254.169.254 on their behalf would hand them our metadata. On a developer's own machine the
 * person choosing the URL and the person at risk are the same, and they can already curl it — so
 * the guard protects nothing there while blocking the first thing anyone tries.
 *
 * It is a command-line flag and nothing else: a repo-committed `.dino.yml` can choose the ADDRESS,
 * and in CI that config is attacker-controllable through a pull request, so the permission to
 * reach private space must come from the human running the command, never from the repository.
 */
export interface EndpointPolicyOptions {
  readonly allowPrivateTarget?: boolean | undefined;
}

/**
 * The policy for a destination Dino did NOT choose: a customer URL in the cloud, a scan target on
 * the pool runner, a token endpoint from a config file.
 *
 * It exists so that choosing strictness is a visible decision rather than an omitted argument. Both
 * guards take the policy as a REQUIRED parameter for the same reason: every default made forgetting
 * it silently correct-looking, and each consumer that forgot had to be found one at a time, by
 * review, after shipping.
 */
export const STRICT_DESTINATION: EndpointPolicyOptions = Object.freeze({ allowPrivateTarget: false });

/** Blocked unless the operator opted in AND the address is one they can legitimately reach. */
function isRefusedIPv4(ip: string, policy: EndpointPolicyOptions): boolean {
  const octets = parseIPv4Octets(ip);
  if (octets === null) return false;
  const permitted = policy.allowPrivateTarget === true && isDeveloperReachableIPv4(octets);
  return !permitted && isBlockedIPv4(octets);
}

/** Refusals decided by the hostname alone: IPv6 form and the metadata names. */
function refuseByHostname(
  hostname: string,
  policy: EndpointPolicyOptions,
): EndpointCheckResult | null {
  if (!isPermittedLoopbackIPv6(hostname, policy) && isBlockedIPv6(hostname)) {
    return { allowed: false, reason: 'blocked_ipv6' };
  }
  if (isIpv6LiteralUnparseable(hostname)) return { allowed: false, reason: 'malformed_url' };
  if (BLOCKED_METADATA_HOSTS.has(hostname) || BLOCKED_METADATA_HOSTS.has(`${hostname}.`)) {
    return { allowed: false, reason: 'metadata_host' };
  }
  return null;
}

export function checkEndpointUrl(
  url: string,
  policy: EndpointPolicyOptions = {},
): EndpointCheckResult {
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

    const hostRefusal = refuseByHostname(hostname, policy);
    if (hostRefusal !== null) return hostRefusal;

    const resolved = resolveToIPv4(hostname);
    if (resolved === null) return { allowed: false, reason: 'unparseable_mapped_ip' };

    if (isIPv4(resolved) && isRefusedIPv4(resolved, policy)) {
      return { allowed: false, reason: 'blocked_ipv4' };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'malformed_url' };
  }
}


/**
 * RFC 6761 reserves `localhost` (and any `*.localhost`) to always mean loopback.
 *
 * Deliberately NOT applied inside {@link checkEndpointUrl}: that runs over EVERY environment in a
 * tenant config, and a config that merely contains a `local` environment is perfectly legitimate —
 * rejecting the name there refuses to load the whole file. It belongs where a target is SELECTED,
 * so the refusal lands on the one URL the run is actually about.
 */
export function isLoopbackHostname(url: string): boolean {
  try {
    let hostname = new URL(url).hostname;
    while (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
    return hostname === 'localhost' || hostname.endsWith('.localhost');
  } catch {
    return false;
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

function validateDnsResolvedIpList(
  ips: string[],
  policy: EndpointPolicyOptions = {},
): DNSValidationResult {
  for (const ip of ips) {
    if (isPermittedLoopbackIPv6(ip, policy)) continue;
    if (isBlockedIPv6(ip)) return { allowed: false, reason: 'blocked_ipv6' };
    if (isIpv6LiteralUnparseable(ip)) return { allowed: false, reason: 'malformed_url' };
    const resolved = resolveToIPv4(ip);
    if (resolved === null) return { allowed: false, reason: 'unparseable_mapped_ip' };
    if (isIPv4(resolved) && isRefusedIPv4(resolved, policy)) {
      return { allowed: false, reason: 'blocked_ipv4' };
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
  resolver: DNSResolver | undefined,
  policy: EndpointPolicyOptions,
): Promise<DNSValidationResult> {
  const staticCheck = checkEndpointUrl(url, policy);
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

  return validateDnsResolvedIpList(ips, policy);
}
