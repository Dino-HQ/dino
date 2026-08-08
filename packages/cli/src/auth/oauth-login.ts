/**
 * OAuth login orchestration — PKCE + loopback + token exchange.
 * Issue #2030.
 */

import http from 'node:http';
import {
  buildAuthorizeUrl,
  canonicalIssuer,
  discover,
  generatePkce,
  generateState,
  resolveOAuthConfig,
} from './oauth-core';
import { TokenExchangeSchema, writeStoredToken, type StoredToken } from './token-store';
import { CliError } from '../shared/errors';
import type { RandomBytes } from './oauth-core';
import type { AddressInfo } from 'node:net';

export interface LoginDeps {
  /** CSPRNG byte source for PKCE verifier + state (default node:crypto). Injectable for tests. */
  randomBytes?: RandomBytes;
  http: typeof fetch;
  now: () => number;
  openBrowser: (url: string) => void;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  noBrowser?: boolean;
  signal?: AbortSignal;
  /** Injectable manual-code reader for --no-browser paste path (tests). */
  readManualCode?: () => Promise<string | null>;
}

interface CallbackResult {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
  errorDescription?: string | undefined;
  /** RFC 9207 authorization-server issuer identifier (SEP-2468), validated when present. */
  iss?: string | undefined;
}

type LoopbackHandle = {
  port: number;
  result: Promise<CallbackResult>;
  close: () => void;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOST = '127.0.0.1';

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

/** Returns true when this request was a terminal /callback (server should latch + close). */
function handleLoopbackRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  settle: (value: CallbackResult) => void,
  rejectFn: (err: Error) => void,
): boolean {
  try {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return false;
    }
    const cb: CallbackResult = {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
      errorDescription: url.searchParams.get('error_description') ?? undefined,
      iss: url.searchParams.get('iss') ?? undefined,
    };
    const ok = cb.error === undefined && cb.code !== undefined;
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      ok
        ? htmlPage('Dino login', 'You can close this window and return to the terminal.')
        : htmlPage('Dino login failed', 'Authorization was denied or incomplete.'),
    );
    settle(cb);
    return true;
  } catch (err) {
    rejectFn(err instanceof Error ? err : new Error(String(err)));
    return true;
  }
}

function createCallbackSettler(): {
  result: Promise<CallbackResult>;
  settle: (value: CallbackResult) => void;
  rejectFn: (err: Error) => void;
} {
  let settled = false;
  let settle!: (value: CallbackResult) => void;
  let rejectFn!: (err: Error) => void;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectFn = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
  });
  return { result, settle, rejectFn };
}

function attachLoopbackTimeout(opts: {
  timeoutMs: number;
  signal?: AbortSignal;
  close: () => void;
  rejectFn: (err: Error) => void;
  result: Promise<CallbackResult>;
}): void {
  // eslint-disable-next-line prettier/prettier -- HC #31 allow-marker must share the timer call line
  const timeout = setTimeout(() => { // determinism:allowed - login loopback wall-clock timeout
    opts.close();
    opts.rejectFn(
      new CliError(
        'Login timed out waiting for the browser callback',
        1,
        'Re-run `dino login`, or use `dino login --no-browser` / set DINO_TOKEN',
      ),
    );
  }, opts.timeoutMs);

  const onAbort = (): void => {
    clearTimeout(timeout);
    opts.close();
    opts.rejectFn(new CliError('Login cancelled', 1, 'Re-run `dino login` when ready'));
  };
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  void opts.result
    .finally(() => {
      clearTimeout(timeout);
      if (opts.signal !== undefined) {
        opts.signal.removeEventListener('abort', onAbort);
      }
      opts.close();
    })
    .catch(() => {
      // Rejection is observed by await loopback.result — do not leave it unhandled.
    });
}

/** Start a single-shot loopback server on 127.0.0.1:0. */
function listenForCallback(opts: {
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<LoopbackHandle> {
  const { result, settle, rejectFn } = createCallbackSettler();
  let handled = false;
  const server = http.createServer((req, res) => {
    // Single-shot: after the first terminal /callback, stop accepting so a local
    // process that races the port cannot inject a second code or probe a validity oracle.
    if (handled) {
      res.writeHead(409, { 'content-type': 'text/plain' });
      res.end('Already handled');
      return;
    }
    if (handleLoopbackRequest(req, res, settle, rejectFn)) {
      handled = true;
      server.close();
    }
  });
  const close = (): void => {
    server.close();
  };

  return new Promise((resolve, reject) => {
    let listening = false;
    server.once('error', (err) => {
      if (!listening) reject(err);
    });
    server.listen(0, LOOPBACK_HOST, () => {
      listening = true;
      const addr = server.address() as AddressInfo;
      attachLoopbackTimeout({
        timeoutMs: opts.timeoutMs,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        close,
        rejectFn,
        result,
      });
      resolve({ port: addr.port, result, close });
    });
  });
}

function tokenFromExchangeBody(json: unknown, now: () => number, issuer: string): StoredToken {
  const parsed = TokenExchangeSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      'Token exchange response was malformed',
      1,
      'Expected access_token and expires_in',
    );
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAtMs: now() + parsed.data.expires_in * 1000,
    issuer,
  };
}

async function exchangeCode(opts: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  verifier: string;
  http: typeof fetch;
  now: () => number;
  issuer: string;
}): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  let res: Response;
  try {
    res = await opts.http(opts.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
  } catch (error_) {
    throw new CliError(
      'Token exchange network error',
      1,
      'Check network connectivity to the issuer token endpoint',
      error_,
    );
  }
  if (!res.ok) {
    throw new CliError('Token exchange failed', 1, `Token endpoint returned HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (error_) {
    throw new CliError('Token exchange returned non-JSON', 1, undefined, error_);
  }
  return tokenFromExchangeBody(json, opts.now, opts.issuer);
}

async function tryManualCodePath(opts: {
  deps: LoginDeps;
  loopback: LoopbackHandle;
  endpoints: { tokenEndpoint: string };
  config: { clientId: string; issuer: string };
  redirectUri: string;
  verifier: string;
}): Promise<StoredToken | null> {
  if (opts.deps.readManualCode === undefined) return null;
  const code = await opts.deps.readManualCode();
  if (code === null || code.trim() === '') return null;
  opts.loopback.close();
  const token = await exchangeCode({
    tokenEndpoint: opts.endpoints.tokenEndpoint,
    code: code.trim(),
    redirectUri: opts.redirectUri,
    clientId: opts.config.clientId,
    verifier: opts.verifier,
    http: opts.deps.http,
    now: opts.deps.now,
    issuer: opts.config.issuer,
  });
  writeStoredToken(token);
  return token;
}

function assertCallbackOk(
  callback: CallbackResult,
  expectedState: string,
  expectedIssuer: string,
): string {
  if (callback.error !== undefined) {
    throw new CliError(
      `Authorization failed: ${callback.error}`,
      1,
      callback.errorDescription ?? 'The user denied consent or the IdP returned an error',
    );
  }
  // RFC 9207 / SEP-2468: if the AS returned `iss`, it MUST match the configured issuer (mix-up defense).
  if (
    callback.iss !== undefined &&
    canonicalIssuer(callback.iss) !== canonicalIssuer(expectedIssuer)
  ) {
    throw new CliError(
      'OAuth issuer mismatch: aborting login',
      1,
      'The authorization response came from an unexpected issuer (possible mix-up). Re-run `dino login`.',
    );
  }
  if (callback.state !== expectedState) {
    throw new CliError(
      'OAuth state mismatch: aborting login',
      1,
      'This can indicate a CSRF attempt. Re-run `dino login`.',
    );
  }
  if (callback.code === undefined || callback.code.length === 0) {
    throw new CliError('Authorization callback missing code', 1, 'Re-run `dino login`');
  }
  return callback.code;
}

/**
 * PKCE + loopback + exchange. Throws CliError and stores nothing on any failure.
 */
export async function runOAuthLogin(deps: LoginDeps): Promise<StoredToken> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const config = resolveOAuthConfig(deps.env);
  const endpoints = await discover(config.issuer, deps.http);
  const pkce = generatePkce(deps.randomBytes);
  const state = generateState(deps.randomBytes);

  const loopback = await listenForCallback({
    timeoutMs,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  const redirectUri = `http://${LOOPBACK_HOST}:${loopback.port}/callback`;
  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: endpoints.authorizationEndpoint,
    clientId: config.clientId,
    redirectUri,
    state,
    challenge: pkce.challenge,
  });

  if (deps.noBrowser === true) {
    console.info('Open this URL in a browser to authorize Dino:');
    console.info(authorizeUrl);
    console.info('');
    console.info(
      'After approving, the browser redirects to a local callback. If that cannot reach this machine, paste the authorization code when prompted (or set DINO_TOKEN).',
    );
    const manual = await tryManualCodePath({
      deps,
      loopback,
      endpoints,
      config,
      redirectUri,
      verifier: pkce.verifier,
    });
    if (manual !== null) return manual;
  } else {
    deps.openBrowser(authorizeUrl);
  }

  let callback: CallbackResult;
  try {
    callback = await loopback.result;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError('Login callback failed', 1, 'Re-run `dino login`', err);
  }

  const code = assertCallbackOk(callback, state, config.issuer);
  const token = await exchangeCode({
    tokenEndpoint: endpoints.tokenEndpoint,
    code,
    redirectUri,
    clientId: config.clientId,
    verifier: pkce.verifier,
    http: deps.http,
    now: deps.now,
    issuer: config.issuer,
  });
  writeStoredToken(token);
  return token;
}
