/**
 * #1759 Spec B3b — wires scan-time auth into the runner REST executor (extracted from runner.ts).
 */

import {
  createOAuth2RefreshLeaseClient,
  isOAuth2RefreshLeaseEnabled,
} from './oauth2-refresh-lease-client';
import { wrapReauthingRestExecutor } from './reauthing-rest-executor';
import {
  wireMultiRoleRbac,
  type RunnerRbacWire,
  hydratedProfileDeclaresRbac,
} from './runner-rbac-wire';
import {
  acquireScanAuth,
  createOtpHttpClient,
  fetchHydratedProfile,
  parseHydratedAuthFlow,
  reauthFromStepIndex,
  type AcquiredScanAuth,
  type HydratedProfile,
  type ScanAuthDeps,
} from './scan-auth';
import { refreshOAuth2Auth } from './scan-auth-oauth2';
import type { RunnerState } from './state-store';
import type { RestFuzzExecutor } from '@dino/agents';
import type { RunnerJob } from '@dino/core';

export type { RunnerRbacWire } from './runner-rbac-wire';

function scanAuthLogger(): { info: (event: string, data?: Record<string, unknown>) => void } {
  return {
    info(event: string, data?: Record<string, unknown>): void {
      console.info(JSON.stringify(data ? { event, ...data } : { event }));
    },
  };
}

type AuthWireContext = {
  state: RunnerState;
  assignment: RunnerJob;
  authProfileId: string;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
};

function buildOtpClient(ctx: AuthWireContext) {
  return createOtpHttpClient({
    cloudEndpoint: ctx.state.cloudEndpoint,
    runnerId: ctx.state.runnerId,
    token: ctx.state.token,
    ...(ctx.assignment.capabilityToken === undefined
      ? {}
      : { capabilityToken: ctx.assignment.capabilityToken }),
    fetchImpl: ctx.fetchImpl,
  });
}

async function hydrateProfile(ctx: AuthWireContext): Promise<HydratedProfile | null> {
  return fetchHydratedProfile({
    cloudEndpoint: ctx.state.cloudEndpoint,
    runnerId: ctx.state.runnerId,
    authProfileId: ctx.authProfileId,
    scanId: ctx.assignment.scanId,
    token: ctx.state.token,
    ...(ctx.assignment.capabilityToken === undefined
      ? {}
      : { capabilityToken: ctx.assignment.capabilityToken }),
    fetchImpl: ctx.fetchImpl,
  });
}

function buildScanAuthDeps(ctx: AuthWireContext, profileId = ctx.authProfileId): ScanAuthDeps {
  const leaseEnabled = isOAuth2RefreshLeaseEnabled();
  return {
    profileId,
    baseUrl: ctx.assignment.targetUrl,
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
    sleep: ctx.sleep,
    rand: ctx.rand,
    otpClient: buildOtpClient(ctx),
    logger: scanAuthLogger(),
    scanId: ctx.assignment.scanId,
    refreshLeaseEnabled: leaseEnabled,
    ...(leaseEnabled
      ? {
          refreshLeaseClient: createOAuth2RefreshLeaseClient({
            cloudEndpoint: ctx.state.cloudEndpoint,
            runnerId: ctx.state.runnerId,
            profileId,
            scanId: ctx.assignment.scanId,
            token: ctx.state.token,
            ...(ctx.assignment.capabilityToken === undefined
              ? {}
              : { capabilityToken: ctx.assignment.capabilityToken }),
            fetchImpl: ctx.fetchImpl,
          }),
          rehydrateProfile: () => hydrateBindingProfile(ctx, profileId),
        }
      : {}),
  };
}

async function hydrateBindingProfile(
  ctx: AuthWireContext,
  bindingAuthProfileId: string,
): Promise<HydratedProfile | null> {
  return fetchHydratedProfile({
    cloudEndpoint: ctx.state.cloudEndpoint,
    runnerId: ctx.state.runnerId,
    authProfileId: bindingAuthProfileId,
    scanId: ctx.assignment.scanId,
    token: ctx.state.token,
    ...(ctx.assignment.capabilityToken === undefined
      ? {}
      : { capabilityToken: ctx.assignment.capabilityToken }),
    fetchImpl: ctx.fetchImpl,
  });
}

async function acquireFromHydrated(
  ctx: AuthWireContext,
  profile: HydratedProfile,
  extra?: { fromStepIndex?: number; otpWindowStartMs?: number },
): Promise<AcquiredScanAuth> {
  return acquireScanAuth(profile, {
    ...buildScanAuthDeps(ctx),
    ...(extra?.fromStepIndex === undefined ? {} : { fromStepIndex: extra.fromStepIndex }),
    ...(extra?.otpWindowStartMs === undefined ? {} : { otpWindowStartMs: extra.otpWindowStartMs }),
  });
}

async function refreshLoginFlowAuth(
  ctx: AuthWireContext,
  profile: HydratedProfile,
): Promise<AcquiredScanAuth> {
  return acquireFromHydrated(ctx, profile, {
    fromStepIndex: reauthFromStepIndex(profile),
    otpWindowStartMs: ctx.now(),
  });
}

async function refreshStaticAuth(
  ctx: AuthWireContext,
  profile: HydratedProfile,
): Promise<{ profile: HydratedProfile; auth: AcquiredScanAuth }> {
  const fresh = await hydrateProfile(ctx);
  if (fresh === null) {
    return { profile, auth: { authFailed: true } };
  }
  const auth = await acquireScanAuth(fresh, {
    profileId: ctx.authProfileId,
    baseUrl: ctx.assignment.targetUrl,
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
    sleep: ctx.sleep,
    rand: ctx.rand,
    logger: scanAuthLogger(),
  });
  return { profile: fresh, auth };
}

export type RunnerAuthWireResult =
  | {
      ok: true;
      restExecutor: RestFuzzExecutor | undefined;
      /** True when an auth profile was hydrated and applied for this scan. */
      authConfigured: boolean;
      /** True when the hydrated profile declares multi-role RBAC (bindings + roles). */
      rbacDeclared?: boolean;
      /** Live acquired scan auth (reflects REST-triggered refresh) - feeds the GraphQL executor wrapper (R4).
       *  Optional for backward-compat with existing wire literals; production always sets it. */
      getAuth?: () => AcquiredScanAuth;
      authLost: () => boolean;
      rotatedRefreshToken: () => string | undefined;
      rbac?: RunnerRbacWire;
    }
  | { ok: false; error: 'auth_failed' };

function readHydratedRefreshToken(profile: HydratedProfile): string | undefined {
  if (profile.credential === null || profile.credential.trim() === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(profile.credential);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const rt = parsed.refresh_token;
    if (typeof rt === 'string' && rt.trim() !== '') {
      return rt;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function latchAuthEverLost(
  authEverLost: { value: boolean },
  auth: AcquiredScanAuth,
): AcquiredScanAuth {
  if (auth.authFailed) {
    authEverLost.value = true;
  }
  return auth;
}

/** One reauth attempt: OAuth2 refresh-token sub-flow → login_flow re-login → static re-hydrate. Returns
 *  the new auth + (possibly rotated) refresh token + (possibly re-hydrated) profile for the caller to latch. */
async function performReauth(p: {
  ctx: AuthWireContext;
  authEverLost: { value: boolean };
  hydratedProfile: HydratedProfile;
  currentRefreshToken: string | undefined;
}): Promise<{
  auth: AcquiredScanAuth;
  hydratedProfile: HydratedProfile;
  currentRefreshToken: string | undefined;
}> {
  const { ctx, authEverLost, hydratedProfile, currentRefreshToken } = p;
  const flow = parseHydratedAuthFlow(hydratedProfile.flow);
  if (
    flow?.refresh !== undefined &&
    currentRefreshToken !== undefined &&
    currentRefreshToken !== ''
  ) {
    const auth = latchAuthEverLost(
      authEverLost,
      await refreshOAuth2Auth(hydratedProfile, buildScanAuthDeps(ctx), currentRefreshToken),
    );
    const nextToken =
      !auth.authFailed && auth.refreshToken !== undefined ? auth.refreshToken : currentRefreshToken;
    return { auth, hydratedProfile, currentRefreshToken: nextToken };
  }
  if (hydratedProfile.strategy === 'login_flow') {
    const auth = latchAuthEverLost(authEverLost, await refreshLoginFlowAuth(ctx, hydratedProfile));
    const nextToken =
      !auth.authFailed && auth.refreshToken !== undefined ? auth.refreshToken : currentRefreshToken;
    return { auth, hydratedProfile, currentRefreshToken: nextToken };
  }
  const refreshed = await refreshStaticAuth(ctx, hydratedProfile);
  return {
    auth: latchAuthEverLost(authEverLost, refreshed.auth),
    hydratedProfile: refreshed.profile,
    currentRefreshToken,
  };
}

function buildRotatedRefreshGetter(
  originalHydratedRefreshToken: string | undefined,
  readCurrentRefreshToken: () => string | undefined,
): () => string | undefined {
  return () => {
    const currentRefreshToken = readCurrentRefreshToken();
    if (currentRefreshToken === undefined || currentRefreshToken === '') {
      return undefined;
    }
    if (
      originalHydratedRefreshToken !== undefined &&
      currentRefreshToken === originalHydratedRefreshToken
    ) {
      return undefined;
    }
    return currentRefreshToken;
  };
}

async function attemptOptionalRbacWire(
  ctx: AuthWireContext,
  hydratedProfile: HydratedProfile,
): Promise<RunnerRbacWire | undefined> {
  try {
    return await wireMultiRoleRbac(hydratedProfile, {
      hydrateProfile: (authProfileId) => hydrateBindingProfile(ctx, authProfileId),
      acquire: (profile, authProfileId) =>
        acquireScanAuth(profile, buildScanAuthDeps(ctx, authProfileId)),
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'runner_rbac_skip',
        reason: err instanceof Error ? err.message : 'invalid_rbac_config',
      }),
    );
    return undefined;
  }
}

function authWireSuccess(opts: {
  restExecutor: RestFuzzExecutor | undefined;
  getAuth: () => AcquiredScanAuth;
  authLost: () => boolean;
  rotatedRefreshToken: () => string | undefined;
  rbac?: RunnerRbacWire;
  rbacDeclared?: boolean;
}): RunnerAuthWireResult {
  return {
    ok: true,
    restExecutor: opts.restExecutor,
    authConfigured: true,
    ...(opts.rbacDeclared === undefined ? {} : { rbacDeclared: opts.rbacDeclared }),
    getAuth: opts.getAuth,
    authLost: opts.authLost,
    rotatedRefreshToken: opts.rotatedRefreshToken,
    ...(opts.rbac === undefined ? {} : { rbac: opts.rbac }),
  };
}

async function wireHydratedAuthProfile(opts: {
  ctx: AuthWireContext;
  baseRestExecutor: RestFuzzExecutor | undefined;
  hasRest: boolean;
  authEverLost: { value: boolean };
}): Promise<RunnerAuthWireResult> {
  const { ctx, baseRestExecutor, hasRest, authEverLost } = opts;
  const authLost = (): boolean => authEverLost.value;

  let hydratedProfile = await hydrateProfile(ctx);
  if (hydratedProfile === null) {
    return { ok: false, error: 'auth_failed' };
  }

  let currentAuth = await acquireFromHydrated(ctx, hydratedProfile);
  if (currentAuth.authFailed) {
    return { ok: false, error: 'auth_failed' };
  }

  let currentRefreshToken = currentAuth.refreshToken;
  const originalHydratedRefreshToken = readHydratedRefreshToken(hydratedProfile);
  const rotatedRefreshToken = buildRotatedRefreshGetter(
    originalHydratedRefreshToken,
    () => currentRefreshToken,
  );

  const rbacDeclared = hydratedProfileDeclaresRbac(hydratedProfile);
  const rbac = await attemptOptionalRbacWire(ctx, hydratedProfile);

  if (!hasRest || baseRestExecutor === undefined) {
    return authWireSuccess({
      restExecutor: baseRestExecutor,
      getAuth: () => currentAuth,
      authLost,
      rotatedRefreshToken,
      ...(rbac === undefined ? {} : { rbac }),
      rbacDeclared,
    });
  }

  const restExecutor = wrapReauthingRestExecutor(baseRestExecutor, {
    getAuth: () => currentAuth,
    refresh: async () => {
      if (hydratedProfile === null) {
        currentAuth = latchAuthEverLost(authEverLost, { authFailed: true });
        return currentAuth;
      }
      const r = await performReauth({ ctx, authEverLost, hydratedProfile, currentRefreshToken });
      hydratedProfile = r.hydratedProfile;
      currentRefreshToken = r.currentRefreshToken;
      currentAuth = r.auth;
      return currentAuth;
    },
    now: ctx.now,
  });

  return authWireSuccess({
    restExecutor,
    getAuth: () => currentAuth,
    authLost,
    rotatedRefreshToken,
    ...(rbac === undefined ? {} : { rbac }),
    rbacDeclared,
  });
}

export async function wireRunnerScanAuth(opts: {
  state: RunnerState;
  assignment: RunnerJob;
  baseRestExecutor: RestFuzzExecutor | undefined;
  hasRest: boolean;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
}): Promise<RunnerAuthWireResult> {
  const { assignment, baseRestExecutor, hasRest } = opts;
  const authProfileId = assignment.authProfileId;
  const authEverLost = { value: false };
  const noRotatedRefresh = (): undefined => undefined;
  if (authProfileId === undefined) {
    return {
      ok: true,
      restExecutor: baseRestExecutor,
      authConfigured: false,
      getAuth: () => ({ authFailed: false }),
      authLost: () => false,
      rotatedRefreshToken: noRotatedRefresh,
    };
  }

  const ctx: AuthWireContext = {
    state: opts.state,
    assignment,
    authProfileId,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
    sleep: opts.sleep,
    rand: opts.rand,
  };

  return wireHydratedAuthProfile({ ctx, baseRestExecutor, hasRest, authEverLost });
}
