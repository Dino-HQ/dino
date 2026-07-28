/**
 * #1759 (#24) — OAuth2 scan-time refresh path (extracted from scan-auth.ts).
 *
 * The initial OAuth2 acquire runs through the generic login_flow path (the cloud compiles the
 * `oauth2` config to an AuthFlowDef at hydrate). This module owns the refresh-token sub-flow:
 * `runAuthRefresh` wrapped in the same L2 transient-retry as the initial acquire, plus the
 * AcquiredScanAuth projection. Honest-fail throughout (INV-2): a failed refresh never yields a token.
 */

import {
  backoffDelayMs,
  classifyAuthFailureReason,
  createBag,
  runAuthRefresh,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_MAX_AUTH_RETRIES,
  type AuthFlowDef,
  type AuthFlowProfile,
  type AuthResult,
  type FlowRunnerDeps,
} from '@dino/auth';
import { recordGet } from '@dino/core';
import {
  buildFlowRunnerDeps,
  buildOtpResolver,
  parseAuthFlow,
  parseLoginFlowSecrets,
  resolveFlowInjections,
  type AcquiredScanAuth,
  type HydratedProfile,
  type ScanAuthDeps,
} from './scan-auth';
import type { OAuth2RefreshLeaseClient } from './oauth2-refresh-lease-client';

const COALESCE_BACKOFF_MS = 250;
const COALESCE_MAX_ATTEMPTS = 3;

/** Project an AuthResult (initial or refresh) into the runner's AcquiredScanAuth, honest-fail on !ok. */
export function authResultToAcquired(opts: {
  profile: HydratedProfile;
  flow: AuthFlowDef;
  secrets: Record<string, string>;
  result: AuthResult;
  deps: ScanAuthDeps;
}): AcquiredScanAuth {
  const { profile, flow, secrets, result, deps } = opts;
  if (!result.ok) {
    deps.logger?.info('scan_auth_failed', {
      profileId: deps.profileId,
      reason: result.reason,
      failedStepIndex: result.failedStepIndex,
      ...(result.reason === 'http_400' && result.failedStepIndex === 0
        ? { terminal: 're_auth_required' }
        : {}),
    });
    return { authFailed: true };
  }
  const { accessTokenVar, refreshTokenVar } = flow.result;
  const authToken =
    accessTokenVar === undefined ? undefined : recordGet(result.vars, accessTokenVar);
  const refreshToken =
    refreshTokenVar === undefined ? undefined : recordGet(result.vars, refreshTokenVar);
  const injections = resolveFlowInjections(flow, secrets, result.vars);
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
}

function isInvalidGrantFailure(result: AuthResult): boolean {
  return !result.ok && result.reason === 'http_400';
}

function acquiredFromCoalescedHydrate(
  profile: HydratedProfile,
  deps: ScanAuthDeps,
): AcquiredScanAuth {
  const flow = parseAuthFlow(profile.flow);
  if (flow === null) {
    return { authFailed: true };
  }
  const secrets = parseLoginFlowSecrets(profile.credential);
  const bag = createBag(secrets);
  const synthetic: AuthResult = {
    ok: true,
    vars: bag.snapshot(),
    cookieHeader: '',
    expiresAt: null,
  };
  deps.logger?.info('oauth2_refresh_coalesced', { profileId: deps.profileId });
  return authResultToAcquired({ profile, flow, secrets, result: synthetic, deps });
}

async function coalesceWithoutIdpRefresh(
  profile: HydratedProfile,
  deps: ScanAuthDeps,
): Promise<AcquiredScanAuth> {
  if (deps.rehydrateProfile === undefined) {
    return { authFailed: true };
  }
  for (let attempt = 0; attempt < COALESCE_MAX_ATTEMPTS; attempt += 1) {
    await deps.sleep(COALESCE_BACKOFF_MS);
    const fresh = await deps.rehydrateProfile();
    if (fresh === null) {
      continue;
    }
    const secrets = parseLoginFlowSecrets(fresh.credential);
    const access = secrets.access_token;
    if (access !== undefined && access.trim() !== '') {
      return acquiredFromCoalescedHydrate(fresh, deps);
    }
  }
  deps.logger?.info('scan_auth_failed', {
    profileId: deps.profileId,
    reason: 'coalesce_exhausted',
  });
  return { authFailed: true };
}

/** runAuthRefresh wrapped in the L2 transient-retry (mirrors runAuthFlowResilient; permanent reasons fail fast). */
async function runAuthRefreshResilient(
  profile: AuthFlowProfile,
  deps: ScanAuthDeps,
  runnerDeps: FlowRunnerDeps,
  refreshToken: string,
): Promise<AuthResult> {
  let last: AuthResult = { ok: false, reason: 'unknown', failedStepIndex: 0 };
  for (let attempt = 0; attempt < DEFAULT_MAX_AUTH_RETRIES; attempt += 1) {
    try {
      const result = await runAuthRefresh(profile, runnerDeps, refreshToken);
      if (result.ok) {
        return result;
      }
      last = result;
      if (classifyAuthFailureReason(result.reason) === 'permanent') {
        return result;
      }
      if (attempt < DEFAULT_MAX_AUTH_RETRIES - 1) {
        await deps.sleep(
          backoffDelayMs(attempt, DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CAP_MS, deps.rand),
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'step_threw';
      last = { ok: false, reason, failedStepIndex: 0 };
    }
  }
  return last;
}

type OtpSetupOk = {
  ok: true;
  secrets: Record<string, string>;
  otpResolver: FlowRunnerDeps['otpResolver'];
};

async function rehydratedRefreshToken(
  deps: ScanAuthDeps,
): Promise<{ profile: HydratedProfile; token: string } | null> {
  if (deps.rehydrateProfile === undefined) {
    return null;
  }
  const fresh = await deps.rehydrateProfile();
  if (fresh === null) {
    return null;
  }
  const nextRt = parseLoginFlowSecrets(fresh.credential).refresh_token;
  if (nextRt === undefined || nextRt.trim() === '') {
    return null;
  }
  return { profile: fresh, token: nextRt };
}

async function runLeasedOAuth2Refresh(opts: {
  profile: HydratedProfile;
  deps: ScanAuthDeps;
  refreshToken: string;
  flow: AuthFlowDef;
  otpSetup: OtpSetupOk;
}): Promise<AcquiredScanAuth> {
  let activeProfile = opts.profile;
  let token = opts.refreshToken;
  for (let invalidGrantAttempt = 0; invalidGrantAttempt < 2; invalidGrantAttempt += 1) {
    const result = await runAuthRefreshResilient(
      {
        profileId: opts.deps.profileId,
        baseUrl: opts.deps.baseUrl,
        flow: opts.flow,
        secrets: opts.otpSetup.secrets,
      },
      opts.deps,
      buildFlowRunnerDeps(opts.deps, opts.otpSetup.otpResolver),
      token,
    );
    if (result.ok) {
      return authResultToAcquired({
        profile: activeProfile,
        flow: opts.flow,
        secrets: opts.otpSetup.secrets,
        result,
        deps: opts.deps,
      });
    }
    if (isInvalidGrantFailure(result) && invalidGrantAttempt === 0) {
      opts.deps.logger?.info('oauth2_refresh_retry_once', { profileId: opts.deps.profileId });
      const rehydrated = await rehydratedRefreshToken(opts.deps);
      if (rehydrated !== null) {
        activeProfile = rehydrated.profile;
        token = rehydrated.token;
        continue;
      }
    }
    if (isInvalidGrantFailure(result)) {
      opts.deps.logger?.info('oauth2_refresh_terminal', {
        profileId: opts.deps.profileId,
        reason: 're_auth_required',
      });
    }
    return authResultToAcquired({
      profile: activeProfile,
      flow: opts.flow,
      secrets: opts.otpSetup.secrets,
      result,
      deps: opts.deps,
    });
  }
  return { authFailed: true };
}

async function refreshOAuth2AuthWithLease(
  profile: HydratedProfile,
  deps: ScanAuthDeps,
  refreshToken: string,
  leaseClient: OAuth2RefreshLeaseClient,
): Promise<AcquiredScanAuth> {
  const acquire = await leaseClient.acquire();
  if (!acquire.ok) {
    deps.logger?.info('scan_auth_failed', {
      profileId: deps.profileId,
      reason: 'lease_acquire_failed',
      detail: acquire.reason,
    });
    return { authFailed: true };
  }
  if (!acquire.acquired) {
    return coalesceWithoutIdpRefresh(profile, deps);
  }

  const flow = parseAuthFlow(profile.flow);
  if (flow?.refresh === undefined) {
    return { authFailed: true };
  }
  const secrets = parseLoginFlowSecrets(profile.credential);
  const otpSetup = buildOtpResolver(profile, secrets, deps);
  if (!otpSetup.ok) {
    return { authFailed: true };
  }

  try {
    return await runLeasedOAuth2Refresh({
      profile,
      deps,
      refreshToken,
      flow,
      otpSetup,
    });
  } finally {
    await leaseClient.release();
  }
}

/** OAuth2 reauth via the grant_type=refresh_token sub-flow, seeding the rotating refresh token. */
export async function refreshOAuth2Auth(
  profile: HydratedProfile,
  deps: ScanAuthDeps,
  refreshToken: string,
): Promise<AcquiredScanAuth> {
  const flow = parseAuthFlow(profile.flow);
  if (flow?.refresh === undefined) {
    deps.logger?.info('scan_auth_failed', { profileId: deps.profileId, reason: 'no_refresh_flow' });
    return { authFailed: true };
  }

  if (deps.refreshLeaseClient !== undefined && deps.refreshLeaseEnabled === true) {
    return refreshOAuth2AuthWithLease(profile, deps, refreshToken, deps.refreshLeaseClient);
  }

  const secrets = parseLoginFlowSecrets(profile.credential);
  const otpSetup = buildOtpResolver(profile, secrets, deps);
  if (!otpSetup.ok) {
    return { authFailed: true };
  }

  const result = await runAuthRefreshResilient(
    { profileId: deps.profileId, baseUrl: deps.baseUrl, flow, secrets: otpSetup.secrets },
    deps,
    buildFlowRunnerDeps(deps, otpSetup.otpResolver),
    refreshToken,
  );
  return authResultToAcquired({ profile, flow, secrets: otpSetup.secrets, result, deps });
}
