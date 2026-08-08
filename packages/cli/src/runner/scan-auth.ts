/**
 * #1759 Spec B3b — scan-time auth: hydrate → acquire (static | login_flow) → apply via executor wrapper.
 */

import { Value } from '@sinclair/typebox/value';
import {
  AuthFlowDefSchema,
  createBag,
  runAuthFlowResilient,
  TestModeOtpResolver,
  type AuthFlowDef,
  type AuthInjection,
  type FetchLike,
  type FlowRunnerDeps,
} from '@dino/auth';
import { recordGet } from '@dino/core';
import { createHttpOtpResolver, type OtpHttpClient } from './http-otp-resolver';
import type { OAuth2RefreshLeaseClient } from './oauth2-refresh-lease-client';

type StaticAuthMethod = 'none' | 'bearer' | 'api_key' | 'basic_auth';

export type { RoleBinding } from './runner-role-token-resolver';

export interface HydratedProfile {
  method: string;
  strategy: string;
  credential: string | null;
  configJson: string | null;
  flow: unknown;
  identity: string;
  inboxAddress: string | null;
  dinoManagedRefused?: string;
  tokenFactory?: {
    rolesJson: string | null;
    rbacExpectationsJson: string | null;
    bindings: ReadonlyArray<{ role: string; authProfileId: string }>;
  } | null;
}

export interface AcquiredScanAuth {
  authToken?: string;
  injections?: readonly AuthInjection[];
  cookieHeader?: string;
  expiresAt?: number | null;
  authFailed: boolean;
  /** ms at acquisition - feeds L1 proportional margin. */
  acquiredAt?: number;
  /** Rotated OAuth2 refresh token (when refresh sub-flow is configured). */
  refreshToken?: string;
}

export interface ScanAuthDeps {
  profileId: string;
  baseUrl: string;
  fetchImpl: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  otpClient?: OtpHttpClient;
  logger?: FlowRunnerDeps['logger'];
  /** Re-auth sub-slice start index (login_flow refresh). */
  fromStepIndex?: number;
  /** INV-3: OTP messages before this ms timestamp are ignored. */
  otpWindowStartMs?: number;
  /** #37: scan id for refresh lease owner token. */
  scanId?: string;
  /** #37: when true, acquire/release lease around IdP refresh. */
  refreshLeaseEnabled?: boolean;
  /** #37: injected cloud lease client (mirrors hydrate fetch seam). */
  refreshLeaseClient?: OAuth2RefreshLeaseClient;
  /** #37: re-fetch hydrated profile after coalesce / invalid_grant retry. */
  rehydrateProfile?: () => Promise<HydratedProfile | null>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseLoginFlowSecrets(credential: string | null): Record<string, string> {
  if (credential === null || credential.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential) as unknown;
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    // eslint-disable-next-line security/detect-object-injection -- k is one of parsed's own keys.
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

export function parseAuthFlow(flow: unknown): AuthFlowDef | null {
  if (flow === null || flow === undefined) {
    return null;
  }
  if (!Value.Check(AuthFlowDefSchema, flow)) {
    return null;
  }
  return flow;
}

export function parseHydratedAuthFlow(flow: unknown): AuthFlowDef | null {
  return parseAuthFlow(flow);
}

export function resolveFlowInjections(
  flow: AuthFlowDef,
  secrets: Record<string, string>,
  vars: Record<string, string>,
): AuthInjection[] {
  const bag = createBag({ ...secrets, ...vars });
  return flow.injections.map((inj) => ({
    target: inj.target,
    name: inj.name,
    valueTemplate: bag.resolve(inj.valueTemplate),
  }));
}

function acquireStaticAuth(profile: HydratedProfile): AcquiredScanAuth {
  const method = profile.method as StaticAuthMethod;
  const credential = profile.credential ?? '';

  if (method === 'none') {
    return { authFailed: false };
  }
  // #1982 — fail closed on a blank credential. Every downstream injection point treats '' as falsy
  // and sends NO auth header, so reporting success here produced a fully unauthenticated scan that
  // still completed CLEAN (false output). Mirrors login_flow's `token_not_acquired` gate. `none` is
  // the one legitimate no-credential method and returns above.
  if (credential.trim() === '') {
    return { authFailed: true };
  }
  if (method === 'bearer') {
    return { authToken: credential, authFailed: false };
  }
  if (method === 'basic_auth') {
    return {
      injections: [
        { target: 'header', name: 'Authorization', valueTemplate: `Basic ${credential}` },
      ],
      authFailed: false,
    };
  }

  const configJson = profile.configJson;
  if (configJson === null || configJson.trim() === '') {
    return { authFailed: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson) as unknown;
  } catch {
    return { authFailed: true };
  }
  if (!isRecord(parsed)) {
    return { authFailed: true };
  }
  const inn = parsed.in;
  const name = parsed.name;
  if (inn !== 'header' && inn !== 'query') {
    return { authFailed: true };
  }
  if (typeof name !== 'string' || name.trim() === '') {
    return { authFailed: true };
  }
  if (inn === 'header') {
    return {
      injections: [{ target: 'header', name, valueTemplate: credential }],
      authFailed: false,
    };
  }
  return {
    injections: [{ target: 'query', name, valueTemplate: credential }],
    authFailed: false,
  };
}

function buildStoredInboxOtpResolver(
  profile: HydratedProfile,
  secrets: Record<string, string>,
  deps: ScanAuthDeps,
  address: string,
):
  | { ok: true; otpResolver: FlowRunnerDeps['otpResolver']; secrets: Record<string, string> }
  | { ok: false } {
  if (deps.otpClient === undefined) {
    return { ok: false };
  }
  const extractPattern = parseAuthFlow(profile.flow)?.otp?.extractPattern;
  const otpResolver = createHttpOtpResolver({
    otpClient: deps.otpClient,
    address,
    now: deps.now,
    sleep: deps.sleep,
    ...(extractPattern === undefined ? {} : { extractPattern }),
    ...(deps.otpWindowStartMs === undefined ? {} : { windowStartMs: deps.otpWindowStartMs }),
  });
  return {
    ok: true,
    otpResolver,
    secrets: { ...secrets, dino_inbox: address },
  };
}

export function buildOtpResolver(
  profile: HydratedProfile,
  secrets: Record<string, string>,
  deps: ScanAuthDeps,
):
  | { ok: true; otpResolver: FlowRunnerDeps['otpResolver']; secrets: Record<string, string> }
  | { ok: false } {
  const identity = profile.identity;

  if (identity === 'test_mode_otp') {
    return {
      ok: true,
      otpResolver: new TestModeOtpResolver(secrets.test_mode_otp ?? null),
      secrets,
    };
  }

  if (identity === 'customer_provided') {
    if (profile.inboxAddress === null) {
      return { ok: false };
    }
    return buildStoredInboxOtpResolver(profile, secrets, deps, profile.inboxAddress);
  }

  if (identity === 'dino_managed') {
    if (profile.dinoManagedRefused !== undefined || profile.inboxAddress === null) {
      return { ok: false };
    }
    return buildStoredInboxOtpResolver(profile, secrets, deps, profile.inboxAddress);
  }

  return { ok: false };
}

export function buildFlowRunnerDeps(
  deps: ScanAuthDeps,
  otpResolver: NonNullable<FlowRunnerDeps['otpResolver']>,
): FlowRunnerDeps {
  return {
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    otpResolver,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  };
}

async function acquireLoginFlowAuth(
  profile: HydratedProfile,
  deps: ScanAuthDeps,
): Promise<AcquiredScanAuth> {
  const flow = parseAuthFlow(profile.flow);
  if (flow === null) {
    deps.logger?.info('scan_auth_failed', { profileId: deps.profileId, reason: 'invalid_flow' });
    return { authFailed: true };
  }

  const secrets = parseLoginFlowSecrets(profile.credential);
  const otpSetup = buildOtpResolver(profile, secrets, deps);
  if (!otpSetup.ok) {
    deps.logger?.info('scan_auth_failed', {
      profileId: deps.profileId,
      reason: 'otp_setup_failed',
    });
    return { authFailed: true };
  }

  try {
    const result = await runAuthFlowResilient(
      { profileId: deps.profileId, baseUrl: deps.baseUrl, flow, secrets: otpSetup.secrets },
      buildFlowRunnerDeps(deps, otpSetup.otpResolver),
      { sleep: deps.sleep, rand: deps.rand },
      deps.fromStepIndex ?? 0,
    );

    if (!result.ok) {
      deps.logger?.info('scan_auth_failed', {
        profileId: deps.profileId,
        reason: result.reason,
        failedStepIndex: result.failedStepIndex,
      });
      return { authFailed: true };
    }

    const { accessTokenVar, refreshTokenVar } = flow.result;
    const authToken =
      accessTokenVar === undefined ? undefined : recordGet(result.vars, accessTokenVar);
    const refreshToken =
      refreshTokenVar === undefined ? undefined : recordGet(result.vars, refreshTokenVar);
    const injections = resolveFlowInjections(flow, otpSetup.secrets, result.vars);

    deps.logger?.info('scan_auth_acquired', {
      profileId: deps.profileId,
      strategy: profile.strategy,
      method: profile.method,
      ok: true,
    });

    return {
      ...(authToken === undefined ? {} : { authToken }),
      ...(refreshToken === undefined || refreshToken === '' ? {} : { refreshToken }),
      injections,
      cookieHeader: result.cookieHeader,
      expiresAt: result.expiresAt,
      acquiredAt: deps.now(),
      authFailed: false,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'flow_threw';
    deps.logger?.info('scan_auth_failed', { profileId: deps.profileId, reason });
    return { authFailed: true };
  }
}

export async function acquireScanAuth(
  profile: HydratedProfile,
  deps: ScanAuthDeps,
): Promise<AcquiredScanAuth> {
  if (profile.strategy === 'login_flow') {
    return acquireLoginFlowAuth(profile, deps);
  }
  const staticAuth = acquireStaticAuth(profile);
  if (staticAuth.authFailed) {
    deps.logger?.info('scan_auth_failed', { profileId: deps.profileId, reason: 'static_invalid' });
    return staticAuth;
  }
  deps.logger?.info('scan_auth_acquired', {
    profileId: deps.profileId,
    strategy: profile.strategy,
    method: profile.method,
    ok: true,
  });
  return { ...staticAuth, acquiredAt: deps.now() };
}

export { buildRoleTokenResolver } from './runner-role-token-resolver';

export async function fetchHydratedProfile(opts: {
  cloudEndpoint: string;
  runnerId: string;
  authProfileId: string;
  scanId: string;
  token: string;
  capabilityToken?: string;
  fetchImpl: FetchLike;
}): Promise<HydratedProfile | null> {
  const base = opts.cloudEndpoint.replace(/\/$/, '');
  const url =
    `${base}/v1/runners/${encodeURIComponent(opts.runnerId)}` +
    `/auth-profiles/${encodeURIComponent(opts.authProfileId)}/hydrate` +
    `?scanId=${encodeURIComponent(opts.scanId)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
  };
  if (opts.capabilityToken !== undefined) {
    headers['x-dino-scan-capability'] = opts.capabilityToken;
  }
  try {
    const res = await opts.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      return null;
    }
    const profile: HydratedProfile = await res.json();
    return profile;
  } catch (err) {
    // Fail closed: a transport failure → null → caller marks auth_failed. Log the error NAME only
    // (never the body/token) for observability without leaking secrets (INV-6).
    console.warn(
      JSON.stringify({
        message: 'runner_hydrate_fetch_failed',
        detail: err instanceof Error ? err.name : 'unknown',
      }),
    );
    return null;
  }
}

export function createOtpHttpClient(opts: {
  cloudEndpoint: string;
  runnerId: string;
  token: string;
  capabilityToken?: string;
  fetchImpl: FetchLike;
}): OtpHttpClient {
  const base = opts.cloudEndpoint.replace(/\/$/, '');
  return {
    async readOtp(address: string): Promise<{ text: string; receivedAt: number } | null> {
      const url =
        `${base}/v1/runners/${encodeURIComponent(opts.runnerId)}/otp` +
        `?address=${encodeURIComponent(address)}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.token}`,
      };
      if (opts.capabilityToken !== undefined) {
        headers['x-dino-scan-capability'] = opts.capabilityToken;
      }
      try {
        const res = await opts.fetchImpl(url, { method: 'GET', headers });
        if (res.status === 200) {
          const body: { text?: unknown; receivedAt?: unknown } = await res.json();
          if (typeof body.text !== 'string') {
            return null;
          }
          const receivedAt = typeof body.receivedAt === 'number' ? body.receivedAt : 0;
          return { text: body.text, receivedAt };
        }
        if (res.status === 204 || res.status === 400 || res.status === 503) {
          return null;
        }
        return null;
      } catch (err) {
        // Poll-safe: a transport failure → null → the resolver keeps polling until its window elapses.
        // Log the error NAME only (never the OTP/address) for observability (INV-6).
        console.warn(
          JSON.stringify({
            message: 'runner_otp_fetch_failed',
            detail: err instanceof Error ? err.name : 'unknown',
          }),
        );
        return null;
      }
    },
  };
}

export function reauthFromStepIndex(profile: HydratedProfile): number {
  const flow = parseAuthFlow(profile.flow);
  return flow?.reauth?.fromStepIndex ?? 0;
}
