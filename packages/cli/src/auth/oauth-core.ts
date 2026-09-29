/**
 * OAuth core — PKCE, config resolution, OIDC discovery (no credential I/O).
 * Issue #2030.
 */

import { Buffer } from 'node:buffer';
import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { z } from 'zod';
import { CliError } from '../shared/errors';

/** CSPRNG byte source for the PKCE verifier + CSRF state (default node:crypto). Injectable for tests. */
export type RandomBytes = (n: number) => Buffer;
/** 32 bytes → 43 base64url chars, satisfying RFC 7636's 43-char minimum verifier length. */
const VERIFIER_BYTES = 32;

/** Live Connected Apps issuer (custom branded auth domain). */
export const LIVE_ISSUER = 'https://login.usedino.dev';
/** Test Connected Apps issuer. */
export const TEST_ISSUER = 'https://login-test.usedino.dev';
/**
 * Confirmed live dino-cli Connected App client_id (#2033). Override with DINO_OAUTH_CLIENT_ID.
 * Tests assert against this constant for the default (live) path.
 */
export const LIVE_CLIENT_ID = 'connected-app-live-51994765-c82e-423a-884a-57cdd137cbea';
/** Confirmed test Connected App client_id (#2033). */
export const TEST_CLIENT_ID = 'connected-app-test-92bc623e-6621-4e2c-b542-33f9553b1601';

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export interface OAuthEnvConfig {
  readonly issuer: string;
  readonly clientId: string;
}

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
}

const OidcDiscoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  revocation_endpoint: z.string().min(1).optional(),
});

/** Strip trailing slashes for issuer comparison (OIDC Discovery §4.3). */
export function canonicalIssuer(issuer: string): string {
  let end = issuer.length;
  while (end > 0 && issuer.codePointAt(end - 1) === 0x2f) end--;
  return issuer.slice(0, end);
}

function base64Url(buf: Buffer): string {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * INV-1: challenge = base64url(sha256(verifier)), method S256.
 * The verifier is base64url of >=32 CSPRNG bytes via node:crypto — NEVER Math.random
 * (a predictable verifier defeats PKCE; Maciver #2030 HIGH). `randomBytes` is injectable
 * for deterministic tests; production uses crypto.randomBytes.
 */
export function generatePkce(randomBytes: RandomBytes = cryptoRandomBytes): PkcePair {
  const verifier = base64Url(randomBytes(VERIFIER_BYTES));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

/** INV-2: CSRF state = base64url of >=32 CSPRNG bytes (unpredictable; defeats state-guessing). */
export function generateState(randomBytes: RandomBytes = cryptoRandomBytes): string {
  return base64Url(randomBytes(VERIFIER_BYTES));
}

function isTestApiUrl(apiUrl: string | undefined): boolean {
  if (apiUrl === undefined || apiUrl.trim() === '') return false;
  const lower = apiUrl.toLowerCase();
  return (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('staging') ||
    lower.includes('api-test') ||
    lower.includes('.workers.dev')
  );
}

/**
 * Resolve issuer + client_id. Default = live; test when DINO_API_URL looks like staging/localhost.
 * DINO_OAUTH_CLIENT_ID / DINO_OAUTH_ISSUER override the resolved pair.
 */
export function resolveOAuthConfig(env: Record<string, string | undefined>): OAuthEnvConfig {
  const useTest = isTestApiUrl(env.DINO_API_URL);
  const defaults: OAuthEnvConfig = useTest
    ? { issuer: TEST_ISSUER, clientId: TEST_CLIENT_ID }
    : { issuer: LIVE_ISSUER, clientId: LIVE_CLIENT_ID };
  const issuer = env.DINO_OAUTH_ISSUER?.trim() ?? defaults.issuer;
  const clientId = env.DINO_OAUTH_CLIENT_ID?.trim() ?? defaults.clientId;
  return { issuer, clientId };
}

function assertHttpsUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error_) {
    // biome-ignore lint/style/useErrorCause: cause forwarded via CliError's 4th arg (biome only detects native Error 2nd-arg cause)
    throw new CliError(`Invalid ${label} URL`, 5, `Check ${label}: ${raw}`, error_, 'config');
  }
  if (parsed.protocol !== 'https:') {
    throw new CliError(`${label} must be https`, 5, `Got: ${raw}`, undefined, 'config');
  }
  return parsed;
}

/**
 * Fetch OIDC discovery document. https-only + issuer exact-match + Zod validation.
 * Pattern: packages/cloud/src/lib/oidc-discovery.ts (CLI-local, no SSRF DNS guard —
 * issuer is a fixed Dino domain, not user-supplied).
 */
/** Fetch + read the discovery JSON. Reach/HTTP failures are transient; a non-JSON body is config. */
async function fetchDiscoveryBody(wellKnownUrl: string, http: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await http(wellKnownUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    });
  } catch (error_) {
    // biome-ignore lint/style/useErrorCause: cause forwarded via CliError's 4th arg (biome only detects native Error 2nd-arg cause)
    throw new CliError(
      'OIDC discovery failed',
      4,
      `Could not reach ${wellKnownUrl}`,
      error_,
      'transient',
      'transient',
    );
  }
  if (!res.ok) {
    // A provider outage can clear; any other refusal means the issuer is misconfigured (OIDC_DISCOVERY_FAILED).
    const transient = res.status === 408 || res.status === 429 || res.status >= 500;
    throw new CliError(
      'OIDC discovery failed',
      transient ? 4 : 5,
      `HTTP ${res.status} from ${wellKnownUrl}`,
      undefined,
      transient ? 'transient' : 'config',
      transient ? 'transient' : 'permanent',
      transient ? undefined : 'OIDC_DISCOVERY_FAILED',
    );
  }
  try {
    return await res.json();
  } catch (error_) {
    // biome-ignore lint/style/useErrorCause: cause forwarded via CliError's 4th arg (biome only detects native Error 2nd-arg cause)
    throw new CliError('OIDC discovery returned non-JSON', 5, wellKnownUrl, error_, 'config');
  }
}

/** Validate the discovery document against the requested issuer and build the https-only endpoints. */
function endpointsFromDiscoveryDoc(
  data: z.infer<typeof OidcDiscoverySchema>,
  base: string,
): OidcEndpoints {
  if (canonicalIssuer(data.issuer) !== base) {
    throw new CliError(
      'OIDC issuer mismatch',
      5,
      `Document issuer ${data.issuer} !== requested ${base}`,
      undefined,
      'config',
      'permanent',
      'OIDC_ISSUER_MISMATCH',
    );
  }
  assertHttpsUrl(data.authorization_endpoint, 'authorization_endpoint');
  assertHttpsUrl(data.token_endpoint, 'token_endpoint');
  if (data.revocation_endpoint !== undefined) {
    assertHttpsUrl(data.revocation_endpoint, 'revocation_endpoint');
  }
  return {
    authorizationEndpoint: data.authorization_endpoint,
    tokenEndpoint: data.token_endpoint,
    revocationEndpoint: data.revocation_endpoint ?? null,
  };
}

export async function discover(issuer: string, http: typeof fetch): Promise<OidcEndpoints> {
  const base = canonicalIssuer(issuer.trim());
  assertHttpsUrl(base, 'issuer');
  const wellKnownUrl = `${base}/.well-known/openid-configuration`;
  const body = await fetchDiscoveryBody(wellKnownUrl, http);
  const parsed = OidcDiscoverySchema.safeParse(body);
  if (!parsed.success) {
    throw new CliError(
      'OIDC discovery document is missing required fields',
      5,
      'Need issuer, authorization_endpoint, token_endpoint',
      undefined,
      'config',
    );
  }
  return endpointsFromDiscoveryDoc(parsed.data, base);
}

/** Build the authorize URL (PKCE S256 + state + offline_access). */
export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes?: string;
}): string {
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scopes ?? 'openid email profile offline_access');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
