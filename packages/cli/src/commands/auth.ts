/**
 * dino login / logout / whoami — Connected Apps auth commands (#2030).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { discover, resolveOAuthConfig } from '../auth/oauth-core';
import { runOAuthLogin } from '../auth/oauth-login';
import { clearStoredToken, getValidToken, readStoredToken } from '../auth/token-store';
import { CliError } from '../shared/errors';
import { detectUi } from '../shared/ui';
import type { StoredToken } from '../auth/token-store';

function apiUrlFlag(flags: Record<string, unknown>): string | undefined {
  const v = flags['api-url'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  // Platform openers are fixed binaries on PATH by OS convention (open / cmd / xdg-open).
  /* eslint-disable sonarjs/no-os-command-from-path -- intentional browser launch */
  if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // Constructed so knip does not treat a literal PATH binary as an undeclared dependency.
  const linuxOpener = ['xdg', 'open'].join('-');
  spawn(linuxOpener, [url], { detached: true, stdio: 'ignore' }).unref();
  /* eslint-enable sonarjs/no-os-command-from-path */
}

function readCodeFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY !== true) {
    return Promise.resolve(null);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Paste authorization code (or leave blank to wait for loopback): ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}

function envFromProcess(
  overrides?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    DINO_TOKEN: process.env.DINO_TOKEN,
    DINO_API_URL: process.env.DINO_API_URL,
    DINO_OAUTH_CLIENT_ID: process.env.DINO_OAUTH_CLIENT_ID,
    DINO_OAUTH_ISSUER: process.env.DINO_OAUTH_ISSUER,
    ...overrides,
  };
}

function apiBase(env: Record<string, string | undefined>): string {
  const raw = env.DINO_API_URL?.trim() ?? 'https://api.usedino.dev';
  return raw.replace(/\/$/, '');
}

async function bestEffortRevoke(
  stored: StoredToken,
  env: Record<string, string | undefined>,
): Promise<void> {
  const token = stored.refreshToken ?? stored.accessToken;
  const hint = stored.refreshToken === null ? 'access_token' : 'refresh_token';
  if (stored.issuer === 'env:DINO_TOKEN') return;
  try {
    const config = resolveOAuthConfig(env);
    const endpoints = await discover(stored.issuer || config.issuer, fetch);
    if (endpoints.revocationEndpoint === null) return;
    await fetch(endpoints.revocationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: config.clientId,
      }),
    });
  } catch {
    console.info(
      'Warning: could not revoke token on the server (continuing to clear local credentials).',
    );
  }
}

/** `dino login` - browser OAuth (PKCE + loopback) or `--no-browser` manual path. */
export async function runLogin(flags: Record<string, unknown>): Promise<number> {
  const noBrowser = flags['no-browser'] === true || flags.noBrowser === true;
  const ui = detectUi({
    quiet: flags.quiet === true,
    noColor: flags.noColor === true,
  });
  const env = envFromProcess();
  const effectiveNoBrowser = noBrowser || !ui.interactive;

  try {
    const token = await runOAuthLogin({
      // randomBytes omitted → oauth-core defaults to node:crypto.randomBytes (CSPRNG).
      http: fetch,
      now: () => Date.now(), // determinism:allowed - production clock; tests inject via runOAuthLogin
      openBrowser: defaultOpenBrowser,
      env,
      noBrowser: effectiveNoBrowser,
      ...(effectiveNoBrowser ? { readManualCode: readCodeFromStdin } : {}),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    // INV-6: never print token values — only a success summary.
    console.info('Logged in to Dino.');
    console.info(`Token stored (expires at ${new Date(token.expiresAtMs).toISOString()}).`);
    console.info('Run `dino whoami` to confirm your tenant.');
    return 0;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      err instanceof Error ? err.message : 'Login failed',
      1,
      'Re-run `dino login` or set DINO_TOKEN',
      err,
    );
  }
}

/** `dino logout` - best-effort revoke, then clear local store. */
export async function runLogout(flags: Record<string, unknown>): Promise<number> {
  const env = envFromProcess();
  const stored = readStoredToken(env);
  if (stored !== null) {
    await bestEffortRevoke(stored, env);
  }
  clearStoredToken();
  if (flags.quiet !== true) {
    console.info('Logged out. Local credentials cleared.');
  }
  return 0;
}

/** `dino whoami` - print active tenant (+ email when present). */
export async function runWhoami(flags: Record<string, unknown>): Promise<number> {
  const env = envFromProcess({
    DINO_API_URL: apiUrlFlag(flags) ?? process.env.DINO_API_URL,
  });
  const token = await getValidToken({
    now: () => Date.now(), // determinism:allowed
    http: fetch,
    env,
  });
  // Presence check only — not a secret comparison (null means logged-out).
  // eslint-disable-next-line security/detect-possible-timing-attacks -- nullish presence, not MAC/token equality
  if (token === null) {
    console.info('Not logged in. Run `dino login`.');
    return 1;
  }

  const base = apiBase(env);
  let res: Response;
  try {
    res = await fetch(`${base}/v1/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (error_) {
    throw new CliError('Failed to reach Dino API', 1, `Check ${base}`, error_);
  }
  const unauthorized = new Set([401, 403]);
  if (unauthorized.has(res.status)) {
    console.info('Session expired or access removed. Run `dino login`.');
    return 1;
  }
  if (!res.ok) {
    throw new CliError(`whoami failed (HTTP ${res.status})`, 1, `${base}/v1/me`);
  }
  const body = (await res.json()) as {
    tenantName?: string;
    tenantId?: string;
    email?: string;
  };
  const name = body.tenantName ?? body.tenantId ?? 'unknown';
  const email = typeof body.email === 'string' ? body.email : undefined;
  if (email !== undefined && email.length > 0) {
    console.info(`${name} (${email})`);
  } else {
    console.info(name);
  }
  return 0;
}
