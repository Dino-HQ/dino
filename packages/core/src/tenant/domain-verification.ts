/**
 * Domain-verification host classifier — scan-target ownership gate (#57).
 * Orthogonal to SSRF `checkEndpointUrl` (private IPs); this requires public FQDNs
 * be covered by a tenant-verified domain (DNS-TXT, #1419).
 *
 * Host normalization (trailing-dot + IPv6-bracket strip) and IP classification are
 * SHARED with `endpoint-validator` so the two T3 gates can never disagree on what a
 * target host is (concentration point — a parser split would open a bypass).
 *
 * INV-4 — pure, total, dot-boundary suffix: host===domain OR endsWith('.'+domain),
 * case-insensitive; no substring/prefix match; empty list → false. Never throws.
 */

import { isIPv4, isIPv6 } from 'node:net';

/** Canonical host of a URL: lowercased, no port, ALL trailing dots stripped, IPv6 brackets removed.
 *  Byte-identical to endpoint-validator's `normalizeHostnameForDnsLookup` so the gate and the SSRF
 *  guard/runner resolve the same host. Null when unparseable or empty. */
export function hostFromUrl(url: string): string | null {
  if (!URL.canParse(url)) return null;
  let host = new URL(url).hostname.toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host === '' ? null : host;
}

/**
 * The ownership class of a scan-target host. The gate acts on this:
 *  - `exempt`      — `localhost` or any single-label host (no dot). Ownership can't apply (nothing to
 *                    DNS-verify); the SSRF `checkEndpointUrl` guard on the runner governs reachability.
 *  - `ip_literal`  — ANY IP literal, v4 or v6, in any form (public, private, transition-prefix,
 *                    mapped, decimal/hex). An IP cannot be DNS-TXT-verified, so it is NOT testable in
 *                    v1 — the gate REJECTS it. We deliberately do NOT reuse the SSRF blocklist to carve
 *                    out "private" IPs: that set marks transition prefixes (6to4/Teredo/NAT64) and
 *                    documentation/CGNAT ranges as "blocked", several of which embed or route to public
 *                    hosts — treating "blocked" as "exempt" reopened a third-party-target bypass. The
 *                    only safe rule is: no IP literal is testable until we add an IP-ownership proof.
 *  - `public_fqdn` — a dotted hostname that MUST be covered by a verified domain.
 */
export type ScanHostClass = 'exempt' | 'ip_literal' | 'public_fqdn';

/** Classify a scan-target host for the ownership gate (INV-2). Pure/total, never throws.
 *  Accepts a raw host; normalizes trailing dots + IPv6 brackets defensively. */
export function classifyScanTargetHost(host: string): ScanHostClass {
  let h = host.toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '' || h === 'localhost') return 'exempt';
  // ANY IP literal (v4/v6, any encoding — new URL() has already normalized decimal/hex/mapped forms)
  // is un-verifiable → rejected. No SSRF-blocklist carve-out: "blocked" ≠ "owned".
  if (isIPv4(h) || isIPv6(h)) return 'ip_literal';
  // Single-label host (no dot) → exempt: not DNS-verifiable, and a bare label does not resolve on a
  // managed pool runner (no search domain); self-hosted runners test their own internal network.
  return h.includes('.') ? 'public_fqdn' : 'exempt';
}

/** True when host is covered by verifiedDomains (INV-4). Blanks ignored. */
export function isHostVerified(host: string, verifiedDomains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const raw of verifiedDomains) {
    const d = raw.trim().toLowerCase().replace(/\.$/, '');
    if (d === '') continue;
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}
