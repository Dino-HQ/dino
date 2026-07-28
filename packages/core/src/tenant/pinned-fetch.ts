// #1850 — SSRF DNS-rebinding pin (Node runner/CLI path only).
//
// Every guarded outbound fetch on the runner did `resolveAndValidateDNS(url)` (resolve + validate the IP) THEN a
// bare `fetch(url)` that RE-RESOLVES DNS — a time-of-check/time-of-use gap a rebinding target slips a private IP
// through. `createPinnedFetch` closes it: it resolves+validates ONCE and connects to the *validated* IP, with the
// TLS `servername` (SNI) and `Host` header kept as the hostname so TLS + virtual-hosting stay correct. Built on
// node:https/node:http (native `lookup` + `servername`) — NODE ONLY. It must never enter the Workers cloud
// bundle (the Worker `fetch` cannot pin anyway — see docs/security/ssrf-dns-rebinding.md); the cloud keeps its
// bare guarded fetch. Mechanism is buffer-and-reconstruct: read the (bounded) body, then return a fresh global
// `Response`, so there is no socket-lifecycle leak and no undici/global-Response type gap.

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIPv6 } from 'node:net';
import { resolveAndValidateDNS } from './endpoint-validator';

/** A 16 MiB default body ceiling — the runner callers already cap smaller; this is a backstop. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** node's custom-`lookup` callback shape — positional (err, address, family) or, when `all`, an array. */
type PinnedLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/** Thrown when the target resolves to a blocked IP (or DNS fails). Callers catch + rethrow their own error. */
export class SsrfBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`SSRF blocked: ${reason}`);
    this.name = 'SsrfBlockedError';
    this.reason = reason;
  }
}

/** The connect-and-read seam. Tests inject it to assert the (ip, family, servername) without real sockets. */
export interface PinnedRequestArgs {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  /** The validated IP the connection MUST target (not a re-resolution of the hostname). */
  readonly resolvedIP: string;
  /** 4 or 6 — derived from resolvedIP so IPv6 / IPv4-mapped addresses pin correctly. */
  readonly family: 4 | 6;
  /** The TLS SNI / Host hostname (never the IP). */
  readonly servername: string;
  readonly signal?: AbortSignal;
}
export type PinnedRequestImpl = (args: PinnedRequestArgs) => Promise<Response>;

export interface PinnedFetchDeps {
  /** Injected DNS resolver (default node:dns) — same seam resolveAndValidateDNS takes. */
  readonly resolver?: Parameters<typeof resolveAndValidateDNS>[1];
  /** Injected connect-and-read seam (default: node:https/node:http pinned request). */
  readonly requestImpl?: PinnedRequestImpl;
  /** Body ceiling; aborts past it. Default 16 MiB. */
  readonly maxBytes?: number;
}

function headerEntries(init: RequestInit['headers']): [string, string][] {
  if (init === undefined) return [];
  if (init instanceof Headers) {
    const out: [string, string][] = [];
    init.forEach((value, key) => out.push([key, value]));
    return out;
  }
  if (Array.isArray(init)) return init.map(([k, v]) => [k, v] as [string, string]);
  return Object.entries(init).filter((e): e is [string, string] => typeof e[1] === 'string');
}

/** Normalize RequestInit headers to a plain record; the caller's `Host` (if any) wins, else we set the hostname. */
function buildHeaders(init: RequestInit | undefined, hostname: string): Record<string, string> {
  const entries = headerEntries(init?.headers);
  const hasHost = entries.some(([k]) => k.toLowerCase() === 'host');
  return Object.fromEntries(hasHost ? entries : [...entries, ['Host', hostname]]);
}

/** #1983 — redirect-chain ceiling (matches the fetch spec's limit) so a loop can't hang a scan. */
const MAX_REDIRECTS = 20;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/** Credential-bearing headers that must not be replayed to a different origin (#1983). */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase())),
  );
}

/**
 * #1983 — resolve + SSRF-validate one hop and assemble its pinned request args. Every hop goes
 * through this, so a redirect target is validated and re-pinned exactly like the original URL —
 * that invariant is what makes following redirects safe. Throws {@link SsrfBlockedError} when the
 * hop resolves to a blocked address (fail-closed — never a Response).
 */
async function buildPinnedArgs(args: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  init: RequestInit | undefined;
  resolver: PinnedFetchDeps['resolver'];
}): Promise<PinnedRequestArgs> {
  const ssrf = await resolveAndValidateDNS(args.url, args.resolver);
  if (!ssrf.allowed) throw new SsrfBlockedError(ssrf.reason);
  // SNI is the bare hostname — URL.hostname keeps brackets for IPv6 literals ([::1]); the connect IP
  // and the cert SNI must both be bracket-free. The Host header keeps `host` (brackets + port).
  const sni = new URL(args.url).hostname.replace(/^\[/, '').replace(/\]$/, '');
  return {
    url: args.url,
    method: args.method,
    headers: args.headers,
    ...(args.body === undefined ? {} : { body: args.body }),
    resolvedIP: ssrf.resolvedIP,
    family: isIPv6(ssrf.resolvedIP) ? 6 : 4,
    servername: sni,
    ...(args.init?.signal ? { signal: args.init.signal } : {}),
  };
}

/**
 * #1983 — derive the next hop's request shape from a redirect response. Cross-origin hops drop
 * credential headers (never replay them at a host the caller did not name — mirrors the auth
 * flow-runner's R9 strip and browser fetch).
 *
 * Method handling: ONLY 303 downgrades to GET (RFC 7231 §6.4.4). 301/302 preserve the method and
 * body — RFC 7231 §6.4.2-3 say a client SHOULD NOT change the method, and the browser-legacy
 * POST→GET rewrite actively breaks the case this fix exists for: an apex/www or http→https
 * canonicalisation in front of a GraphQL endpoint would answer the rewritten bodyless GET with
 * `204 No Content`, so introspection still failed — just with a new symptom. 307/308 preserve by
 * definition. Verified at runtime against a real 301-ing public GraphQL API.
 */
function nextHop(args: {
  from: URL;
  location: string;
  status: number;
  method: string;
  headers: Record<string, string>;
}): { url: string; method: string; headers: Record<string, string>; dropBody: boolean } {
  const target = new URL(args.location, args.from.href);
  const carried = sameOrigin(args.from, target)
    ? args.headers
    : stripCredentialHeaders(args.headers);
  const downgrade = args.status === 303;
  return {
    url: target.href,
    method: downgrade ? 'GET' : args.method,
    headers: { ...carried, Host: target.host },
    dropBody: downgrade,
  };
}

/** A custom DNS lookup that ALWAYS returns the pre-validated IP (the hostname is never re-resolved). */
function makePinnedLookup(resolvedIP: string, family: 4 | 6) {
  return (
    _hostname: string,
    options: { all?: boolean | undefined },
    callback: PinnedLookupCallback,
  ): void => {
    // node expects an array of {address, family} when `all` is set, else positional (err, address, family).
    if (options.all === true) callback(null, [{ address: resolvedIP, family }]);
    else callback(null, resolvedIP, family);
  };
}

interface Settle {
  readonly resolve: (r: Response) => void;
  readonly reject: (e: unknown) => void;
}

/** Buffer the (bounded) response and resolve a reconstructed global Response; reject on overflow / transport error. */
function streamResponse(
  req: ClientRequest,
  res: IncomingMessage,
  maxBytes: number,
  settle: Settle,
): void {
  const chunks: Buffer[] = [];
  let total = 0;
  res.on('data', (chunk: Buffer) => {
    total += chunk.byteLength;
    if (total > maxBytes) {
      req.destroy();
      settle.reject(new Error('pinnedFetch response exceeded maxBytes'));
      return;
    }
    chunks.push(chunk);
  });
  res.on('end', () => settle.resolve(toResponse(res, new Uint8Array(Buffer.concat(chunks)))));
  res.on('error', settle.reject);
}

function bodyToString(body: RequestInit['body']): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return body;
  // The runner guarded calls only ever send string bodies (JSON). A non-string body is a caller error.
  throw new TypeError('pinnedFetch supports only string request bodies');
}

/** Build a global Response from a buffered node:http IncomingMessage, preserving multiple set-cookie values. */
function toResponse(res: IncomingMessage, bodyBytes: Uint8Array): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v); // set-cookie etc. — keep every value
    } else {
      headers.append(key, value);
    }
  }
  const status = res.statusCode ?? 0;
  // 204/304 must not carry a body per the Response constructor contract.
  const hasBody = status !== 204 && status !== 304 && bodyBytes.byteLength > 0;
  // Preserve the reason phrase (callers read res.statusText). The Response ctor rejects a statusText for some
  // statuses with an empty phrase, so only pass a non-empty one.
  const statusText = res.statusMessage ?? '';
  // Pass a plain ArrayBuffer (a valid Response body in both the Node and DOM lib typings) to avoid the
  // Uint8Array<ArrayBufferLike> generic mismatch between them.
  const ab = bodyBytes.buffer.slice(
    bodyBytes.byteOffset,
    bodyBytes.byteOffset + bodyBytes.byteLength,
  ) as ArrayBuffer;
  return new Response(hasBody ? ab : null, {
    status,
    headers,
    ...(statusText === '' ? {} : { statusText }),
  });
}

/**
 * The default {@link PinnedRequestImpl}: a node:https/node:http request whose DNS `lookup` ALWAYS returns the
 * pre-validated IP (the hostname is never re-resolved), with SNI = the hostname (https). Exported so a
 * loopback-server integration test can prove the pin end-to-end (createPinnedFetch's own validator blocks
 * loopback, so the real-socket path can only be exercised by calling this directly).
 */
export function createNodePinnedRequest(maxBytes = DEFAULT_MAX_BYTES): PinnedRequestImpl {
  return (args) =>
    new Promise<Response>((resolve, reject) => {
      const isHttps = new URL(args.url).protocol === 'https:';
      const requestFn = isHttps ? httpsRequest : httpRequest;
      const req = requestFn(
        args.url,
        {
          method: args.method,
          headers: args.headers,
          lookup: makePinnedLookup(args.resolvedIP, args.family),
          // SNI + cert validation use the hostname, not the IP (https only).
          ...(isHttps ? { servername: args.servername } : {}),
        },
        (res) => streamResponse(req, res, maxBytes, { resolve, reject }),
      );
      if (args.signal?.aborted) {
        req.destroy();
        reject(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      args.signal?.addEventListener('abort', () => req.destroy(), { once: true });
      req.on('error', reject);
      if (args.body !== undefined) req.write(args.body);
      req.end();
    });
}

/** Extract the request URL string from a fetch input. The runner/CLI callers only ever pass a string or URL. */
function toUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  // A Request object would carry its own method/headers/body that this pin path does not read — the runner
  // callers never pass one, so fail loudly rather than silently drop them.
  throw new TypeError('pinnedFetch does not accept a Request object — pass (url, init)');
}

/**
 * A pinning replacement for the global `fetch` (typed as `typeof fetch` so it drops into `fetch`/FetchLike
 * call sites). It pins the connection to the validated IP (closing the DNS-rebinding TOCTOU); the underlying
 * request never re-resolves the hostname, and SNI + Host stay the hostname. On a blocked/failed resolution it
 * throws {@link SsrfBlockedError} (fail-closed — never a Response).
 */
export function createPinnedFetch(deps: PinnedFetchDeps = {}): typeof fetch {
  const doRequest = deps.requestImpl ?? createNodePinnedRequest(deps.maxBytes ?? DEFAULT_MAX_BYTES);
  return async (input: string | URL | Request, init?: RequestInit) => {
    let url = toUrlString(input);
    let method = init?.method ?? 'GET';
    let body = bodyToString(init?.body);
    let headers = buildHeaders(init, new URL(url).host);

    // #1983 — follow redirects like the global fetch this stands in for (graphql-request, and every
    // other `typeof fetch` consumer, expects it; returning the 3xx envelope made introspection fail
    // on any endpoint that canonicalises via 301). INV: EVERY hop is re-validated through
    // resolveAndValidateDNS and re-pinned to its own IP, so a redirect can never become an SSRF
    // bypass. `redirect: 'manual'` still returns the 3xx untouched (the REST executor classifies
    // redirects itself and must keep that behavior).
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) {
        throw new Error(`pinnedFetch exceeded ${MAX_REDIRECTS} redirects`);
      }
      const u = new URL(url);
      const res = await doRequest(
        await buildPinnedArgs({ url, method, headers, body, init, resolver: deps.resolver }),
      );

      const location = isRedirectStatus(res.status) ? res.headers.get('location') : null;
      if (location === null || init?.redirect === 'manual' || init?.redirect === 'error') {
        return res;
      }

      const next = nextHop({ from: u, location, status: res.status, method, headers });
      ({ method, headers, body } = { ...next, body: next.dropBody ? undefined : body });
      url = next.url;
    }
  };
}
