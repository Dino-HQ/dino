/**
 * Tiered token store: DINO_TOKEN env → ~/.dino/credentials.json (mode 0600).
 * Issue #2030. OS keychain deferred (keeps the single-file esbuild bundle dependency-free).
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveOAuthConfig, discover } from './oauth-core';
import { getGlobalDinoConfigPath } from '../config/global-dino-config';
import { CliError } from '../shared/errors';

export interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
  issuer: string;
}

const StoredTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAtMs: z.number().refine((n) => Number.isFinite(n)),
  issuer: z.string().min(1),
});

const TokenExchangeSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().refine((n) => n > 0),
  token_type: z.string().optional(),
});

const LOCK_NAME = 'credentials.lock';
const CREDENTIALS_NAME = 'credentials.json';
/** Refresh a little early so callers don't race expiry. */
const EXPIRY_SKEW_MS = 30_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 5_000;

/** Map catch failures on optional auth paths to logged-out (never throw). */
function loggedOut(_err: unknown): null {
  return null;
}

function dinoDir(): string {
  return path.dirname(getGlobalDinoConfigPath());
}

function credentialsPath(): string {
  return path.join(dinoDir(), CREDENTIALS_NAME);
}

function lockPath(): string {
  return path.join(dinoDir(), LOCK_NAME);
}

function ensureDinoDir(): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed .dino under DINO_HOME/home
  fs.mkdirSync(dinoDir(), { recursive: true });
}

/** Corrupt / missing file → null (logged-out). Never throws. */
export function readStoredToken(env: Record<string, string | undefined>): StoredToken | null {
  const fromEnv = env.DINO_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return {
      accessToken: fromEnv,
      refreshToken: null,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      issuer: 'env:DINO_TOKEN',
    };
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename under .dino
    const raw = fs.readFileSync(credentialsPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = StoredTokenSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data;
  } catch (err) {
    return loggedOut(err);
  }
}

/** mkdir + writeFile mode 0o600. */
export function writeStoredToken(t: StoredToken): void {
  const validated = StoredTokenSchema.safeParse(t);
  if (!validated.success) {
    throw new CliError('Refusing to store invalid token', 1, 'Token failed schema validation');
  }
  const target = credentialsPath();
  const tmp = `${target}.tmp`;
  try {
    ensureDinoDir();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename under .dino
    fs.writeFileSync(tmp, `${JSON.stringify(validated.data, null, 2)}\n`, {
      mode: 0o600,
      flag: 'w',
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename under .dino
    fs.chmodSync(tmp, 0o600);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename under .dino
    fs.renameSync(tmp, target);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename under .dino
    fs.chmodSync(target, 0o600);
  } catch (error_) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- cleanup tmp
      fs.unlinkSync(tmp);
    } catch {
      void 0; // ignore — tmp may not exist if mkdir failed first
    }
    throw new CliError(
      'Failed to write credentials file',
      1,
      `Ensure ${dinoDir()} is writable (mode 0600 target: ${target})`,
      error_,
    );
  }
}

export function clearStoredToken(): void {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename under .dino
    fs.unlinkSync(credentialsPath());
  } catch {
    void 0; // already gone
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- lock cleanup
    fs.unlinkSync(lockPath());
  } catch {
    void 0; // ignore
  }
}

function sleepMs(ms: number): Promise<void> {
  // Lock backoff — wall clock; not part of token-expiry math (HC #31 clock seam is `now`).
  return new Promise((resolve) => {
    setTimeout(resolve, ms); // determinism:allowed
  });
}

/** Acquire an O_EXCL lock file (INV-5 single-flight refresh). */
async function acquireLock(now: () => number): Promise<void> {
  ensureDinoDir();
  const lp = lockPath();
  const deadline = now() + LOCK_MAX_WAIT_MS;
  while (now() <= deadline) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed lock under .dino
      const fd = fs.openSync(lp, 'wx', 0o600);
      try {
        fs.writeSync(fd, `${process.pid}\n${String(now())}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw new CliError('Failed to acquire credentials lock', 1, lp, err);
      }
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- stale lock check
        const st = fs.statSync(lp);
        if (now() - st.mtimeMs > LOCK_STALE_MS) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- stale unlock
          fs.unlinkSync(lp);
          continue;
        }
      } catch {
        void 0; // raced with unlock — retry
      }
      await sleepMs(LOCK_RETRY_MS);
    }
  }
  throw new CliError('Timed out waiting for credentials lock', 1, lp);
}

function releaseLock(): void {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- unlock
    fs.unlinkSync(lockPath());
  } catch {
    void 0; // ignore
  }
}

/**
 * Refresh outcome. `invalid` = the refresh token itself was authoritatively rejected
 * (clear + re-login). `transient` = a network/server hiccup — the caller MUST keep the
 * stored credential and retry later, never destroy a valid refresh token on a blip
 * (Maciver #2030 MEDIUM).
 */
type RefreshOutcome =
  | { status: 'ok'; token: StoredToken }
  | { status: 'invalid' }
  | { status: 'transient' };

async function refreshAccessToken(
  stored: StoredToken,
  deps: { now: () => number; http: typeof fetch; env: Record<string, string | undefined> },
): Promise<RefreshOutcome> {
  if (stored.refreshToken === null || stored.refreshToken.length === 0) {
    return { status: 'invalid' };
  }
  const config = resolveOAuthConfig(deps.env);
  let endpoints;
  try {
    endpoints = await discover(stored.issuer || config.issuer, deps.http);
  } catch {
    return { status: 'transient' };
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    client_id: config.clientId,
  });
  let res: Response;
  try {
    res = await deps.http(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
  } catch {
    return { status: 'transient' };
  }
  if (!res.ok) {
    // 400/401 = the refresh token is rejected (invalid_grant) → re-login required.
    // 5xx / other = server hiccup → keep the credential and retry later.
    return res.status === 400 || res.status === 401
      ? { status: 'invalid' }
      : { status: 'transient' };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { status: 'transient' };
  }
  const parsed = TokenExchangeSchema.safeParse(json);
  if (!parsed.success) return { status: 'transient' };
  const next: StoredToken = {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? stored.refreshToken,
    expiresAtMs: deps.now() + parsed.data.expires_in * 1000,
    issuer: stored.issuer || config.issuer,
  };
  writeStoredToken(next);
  return { status: 'ok', token: next };
}

/**
 * Return a usable access token, refreshing under an O_EXCL lock when expired.
 * On refresh failure → clear store and return null (require re-login).
 */
export async function getValidToken(deps: {
  now: () => number;
  http: typeof fetch;
  env: Record<string, string | undefined>;
}): Promise<string | null> {
  const fromEnv = deps.env.DINO_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  const stored = readStoredToken(deps.env);
  if (stored === null) return null;

  if (deps.now() < stored.expiresAtMs - EXPIRY_SKEW_MS) {
    return stored.accessToken;
  }

  await acquireLock(deps.now);
  try {
    // Re-read after lock — another process may have refreshed.
    const again = readStoredToken(deps.env);
    if (again !== null && deps.now() < again.expiresAtMs - EXPIRY_SKEW_MS) {
      return again.accessToken;
    }
    if (again === null) return null;
    const refreshed = await refreshAccessToken(again, deps);
    if (refreshed.status === 'ok') {
      return refreshed.token.accessToken;
    }
    if (refreshed.status === 'invalid') {
      // Authoritative rejection (invalid_grant) — the refresh token is dead → require re-login.
      clearStoredToken();
      return null;
    }
    // Transient network/server error — preserve the stored credential so a later online
    // call can refresh; never destroy a valid refresh token on a blip (Maciver #2030 MEDIUM).
    return null;
  } finally {
    releaseLock();
  }
}

/** Zod schema for token-endpoint responses (shared with oauth-login). */
export { TokenExchangeSchema };
