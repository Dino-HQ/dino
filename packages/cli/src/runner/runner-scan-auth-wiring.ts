/**
 * #1759 Spec B3b — wires scan-time auth into the runner REST executor (extracted from runner.ts).
 */

import {
  createOAuth2RefreshLeaseClient,
  isOAuth2RefreshLeaseEnabled,
} from './oauth2-refresh-lease-client';
import { wrapReauthingRestExecutor } from './reauthing-rest-executor';
import { boundRoleIdentities, createAuthenticationRecorder, NOT_RELEASED, type AuthenticationRecorder } from './authentication-report';
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
import { outcomeFromCaughtError } from '../shared/outcome';
import type { CredentialFailureSink, ReleaseRefusalCode } from './runner-hydrate';
import { refreshOAuth2Auth } from './scan-auth-oauth2';
import { buildRotatedRefreshGetter, readHydratedRefreshToken } from './runner-refresh-token';
import type { RunnerState } from './state-store';
import type { RestFuzzExecutor } from '@dino/agents';
import type { AuthenticationAcquisitionReport, CredentialNextAction, RunnerJob } from '@dino/core';

export type { RunnerRbacWire } from './runner-rbac-wire';

function scanAuthLogger(): { info: (event: string, data?: Record<string, unknown>) => void } {
  return {
    info(event: string, data?: Record<string, unknown>): void {
      console.info(JSON.stringify(data ? { event, ...data } : { event }));
    },
  };
}

type AuthWireContext = {
  /** P1F: the last typed credential outcome the cloud returned for this scan's hydrate. */
  credentialFailure?: { code?: ReleaseRefusalCode; nextAction?: CredentialNextAction | undefined };
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

/** Every hydrate (primary, refresh, RBAC role) latches the FIRST typed credential outcome for the scan. */
function latchCredentialFailure(ctx: AuthWireContext): CredentialFailureSink {
  return (code, nextAction) => {
    ctx.credentialFailure ??= { code, nextAction };
  };
}

async function hydrateProfile(ctx: AuthWireContext): Promise<HydratedProfile | null> {
  return fetchHydratedProfile({
    onCredentialFailure: latchCredentialFailure(ctx),
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
  signal?: AbortSignal,
): Promise<HydratedProfile | null> {
  return fetchHydratedProfile({
    onCredentialFailure: latchCredentialFailure(ctx),
    cloudEndpoint: ctx.state.cloudEndpoint,
    runnerId: ctx.state.runnerId,
    authProfileId: bindingAuthProfileId,
    scanId: ctx.assignment.scanId,
    token: ctx.state.token,
    ...(ctx.assignment.capabilityToken === undefined
      ? {}
      : { capabilityToken: ctx.assignment.capabilityToken }),
    fetchImpl: ctx.fetchImpl,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function acquireFromHydrated(
  ctx: AuthWireContext,
  profile: HydratedProfile,
  extra?: { fromStepIndex?: number; otpWindowStartMs?: number; signal?: AbortSignal },
): Promise<AcquiredScanAuth> {
  return acquireScanAuth(profile, {
    ...buildScanAuthDeps(ctx),
    ...(extra?.fromStepIndex === undefined ? {} : { fromStepIndex: extra.fromStepIndex }),
    ...(extra?.otpWindowStartMs === undefined ? {} : { otpWindowStartMs: extra.otpWindowStartMs }),
    ...(extra?.signal === undefined ? {} : { signal: extra.signal }),
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
    return { profile, auth: NOT_RELEASED };
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
      /** P1F: a typed credential outcome latched mid-scan (role hydrate, re-hydrate); it fails the scan. */
      credentialFailure?: () => ReleaseRefusalCode | undefined;
      /** DIN-1492: what this run proved about authentication, read at the end of the run. */
      authentication?: () => AuthenticationAcquisitionReport | undefined;
      /** DIN-1492: the final status of an authenticated request outside the REST wrapper (GraphQL). */
      targetResponse?: (status: number) => void;
    }
  | {
      ok: false;
      error: 'auth_failed';
      credentialCode?: ReleaseRefusalCode;
      credentialNextAction?: CredentialNextAction;
      authentication?: AuthenticationAcquisitionReport;
    };

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

async function attemptOptionalRbacWire(
  ctx: AuthWireContext,
  hydratedProfile: HydratedProfile,
  recorder: AuthenticationRecorder,
): Promise<RunnerRbacWire | undefined> {
  try {
    return await wireMultiRoleRbac(hydratedProfile, {
      hydrateProfile: async (authProfileId, signal) => {
        const profile = await hydrateBindingProfile(ctx, authProfileId, signal);
        // Dino did not release this role for the run: a closed outcome, not a silent gap.
        if (profile === null) {
          recorder.acquisition(authProfileId, NOT_RELEASED);
        }
        return profile;
      },
      acquire: async (profile, authProfileId, signal) => {
        const auth = await acquireScanAuth(profile, {
          ...buildScanAuthDeps(ctx, authProfileId),
          ...(signal === undefined ? {} : { signal }),
        });
        recorder.acquisition(authProfileId, auth);
        return auth;
      },
    });
  } catch (err) {
    // Kind and code say whether the skip is the operator's config or Dino's fault (#2636).
    const outcome = outcomeFromCaughtError(err);
    const code = outcome.error?.code;
    console.warn(
      JSON.stringify({
        event: 'runner_rbac_skip',
        reason: err instanceof Error ? err.message : 'invalid_rbac_config',
        kind: outcome.kind,
        ...(code === undefined ? {} : { code }),
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
  credentialFailure: () => ReleaseRefusalCode | undefined;
  recorder: AuthenticationRecorder;
}): RunnerAuthWireResult {
  return {
    ok: true,
    restExecutor: opts.restExecutor,
    authConfigured: true,
    credentialFailure: opts.credentialFailure,
    authentication: () => opts.recorder.report(),
    targetResponse: (status) => opts.recorder.targetResponse(status),
    ...(opts.rbacDeclared === undefined ? {} : { rbacDeclared: opts.rbacDeclared }),
    getAuth: opts.getAuth,
    authLost: opts.authLost,
    rotatedRefreshToken: opts.rotatedRefreshToken,
    ...(opts.rbac === undefined ? {} : { rbac: opts.rbac }),
  };
}

/**
 * P1F: a failed hydrate carries the cloud's typed credential outcome when there was one (the cloud shows that as
 * not attempted). DIN-1492: any other failure (grant or hydrate unreachable, 5xx, malformed body) is still a fact of
 * this run: Dino did not release the identity, reported as a closed outcome rather than silence.
 */
function hydrateFailure(ctx: AuthWireContext, recorder: AuthenticationRecorder): RunnerAuthWireResult {
  const { code, nextAction } = ctx.credentialFailure ?? {};
  if (code !== undefined) {
    return { ok: false, error: 'auth_failed', credentialCode: code, ...(nextAction ? { credentialNextAction: nextAction } : {}) };
  }
  recorder.acquisition(ctx.authProfileId, NOT_RELEASED);
  return acquisitionFailure(recorder);
}


/** DIN-1492: the run could not acquire context; the report says why (a closed code). */
function acquisitionFailure(recorder: AuthenticationRecorder): RunnerAuthWireResult {
  const authentication = recorder.report();
  return authentication === undefined
    ? { ok: false, error: 'auth_failed' }
    : { ok: false, error: 'auth_failed', authentication };
}

async function wireHydratedAuthProfile(opts: {
  ctx: AuthWireContext;
  baseRestExecutor: RestFuzzExecutor | undefined;
  hasRest: boolean;
  authEverLost: { value: boolean };
}): Promise<RunnerAuthWireResult> {
  const { ctx, baseRestExecutor, hasRest, authEverLost } = opts;
  const recorder = createAuthenticationRecorder();
  const authLost = (): boolean => authEverLost.value;

  let hydratedProfile = await hydrateProfile(ctx);
  if (hydratedProfile === null) return hydrateFailure(ctx, recorder);

  recorder.expect(boundRoleIdentities(hydratedProfile));
  let currentAuth = await acquireFromHydrated(ctx, hydratedProfile);
  recorder.acquisition(ctx.authProfileId, currentAuth);
  if (currentAuth.authFailed) return acquisitionFailure(recorder);

  let currentRefreshToken = currentAuth.refreshToken;
  const originalHydratedRefreshToken = readHydratedRefreshToken(hydratedProfile);
  const rotatedRefreshToken = buildRotatedRefreshGetter(
    originalHydratedRefreshToken,
    () => currentRefreshToken,
  );

  const credentialFailure = (): ReleaseRefusalCode | undefined => ctx.credentialFailure?.code;
  const rbacDeclared = hydratedProfileDeclaresRbac(hydratedProfile);
  const rbac = await attemptOptionalRbacWire(ctx, hydratedProfile, recorder);
  const success = (restExecutor: RestFuzzExecutor | undefined): RunnerAuthWireResult =>
    authWireSuccess({
      restExecutor,
      getAuth: () => currentAuth,
      authLost,
      rotatedRefreshToken,
      ...(rbac === undefined ? {} : { rbac }),
      rbacDeclared,
      credentialFailure,
      recorder,
    });

  if (!hasRest || baseRestExecutor === undefined) return success(baseRestExecutor);

  const restExecutor = wrapReauthingRestExecutor(baseRestExecutor, {
    getAuth: () => currentAuth,
    refresh: async () => {
      if (hydratedProfile === null) {
        currentAuth = latchAuthEverLost(authEverLost, NOT_RELEASED);
        recorder.reacquisition(ctx.authProfileId, currentAuth);
        return currentAuth;
      }
      const r = await performReauth({ ctx, authEverLost, hydratedProfile, currentRefreshToken });
      hydratedProfile = r.hydratedProfile;
      currentRefreshToken = r.currentRefreshToken;
      currentAuth = r.auth;
      recorder.reacquisition(ctx.authProfileId, currentAuth);
      return currentAuth;
    },
    now: ctx.now,
    onFinalStatus: (status) => recorder.targetResponse(status),
  });
  return success(restExecutor);
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
