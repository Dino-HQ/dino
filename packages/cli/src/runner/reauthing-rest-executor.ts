/**
 * #1759 Spec B3b — REST executor wrapper: apply auth, pre-emptive refresh, 401 retry (single-flight).
 */

import { computeRefreshMargin } from './reauth-policy';
import type { AcquiredScanAuth } from './scan-auth';
import type { RestExecutionOptions, RestFuzzExecutor } from '@dino/agents';
import { observeTransport, mergeTransportStates, type TransportState } from '@dino/core';

const DEFAULT_EXPIRY_MARGIN_MS = 60_000;

function mergeAuthIntoOptions(
  options: RestExecutionOptions,
  auth: AcquiredScanAuth,
): RestExecutionOptions {
  const headers: Record<string, string> = { ...options.headers };
  if (auth.cookieHeader !== undefined && auth.cookieHeader !== '') {
    headers.Cookie = auth.cookieHeader;
  }
  return {
    ...options,
    headers,
    ...(auth.authToken === undefined ? {} : { authToken: auth.authToken }),
    ...(auth.injections !== undefined && auth.injections.length > 0
      ? { injections: auth.injections }
      : {}),
  };
}

function isNearExpiry(
  expiresAt: number | null | undefined,
  now: number,
  marginMs: number,
): boolean {
  if (expiresAt === null || expiresAt === undefined) {
    return false;
  }
  return now >= expiresAt - marginMs;
}

function retryObservation(options: RestExecutionOptions) {
  let firstState: TransportState = 'unknown';
  return {
    first: (state: TransportState) => {
      firstState = state;
      observeTransport(options, state);
    },
    retry: (state: TransportState) =>
      observeTransport(options, mergeTransportStates(firstState, state)),
  };
}

export function wrapReauthingRestExecutor(
  base: RestFuzzExecutor,
  opts: {
    getAuth: () => AcquiredScanAuth;
    refresh: () => Promise<AcquiredScanAuth>;
    now: () => number;
    expiryMarginMs?: number;
  },
): RestFuzzExecutor {
  let refreshInFlight: Promise<AcquiredScanAuth> | null = null;

  async function singleFlightRefresh(): Promise<AcquiredScanAuth> {
    if (refreshInFlight !== null) {
      return refreshInFlight;
    }
    refreshInFlight = opts.refresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function authForCall(): Promise<AcquiredScanAuth> {
    let auth = opts.getAuth();
    if (auth.authFailed) {
      return auth;
    }
    const marginMs =
      auth.acquiredAt !== undefined && auth.expiresAt != null
        ? computeRefreshMargin(auth.expiresAt - auth.acquiredAt)
        : (opts.expiryMarginMs ?? DEFAULT_EXPIRY_MARGIN_MS);
    if (isNearExpiry(auth.expiresAt, opts.now(), marginMs)) {
      auth = await singleFlightRefresh();
    }
    return auth;
  }

  return executeWithReauth(base, { authForCall, singleFlightRefresh });
}

function executeWithReauth(base: RestFuzzExecutor, authProvider: {
  authForCall: () => Promise<AcquiredScanAuth>;
  singleFlightRefresh: () => Promise<AcquiredScanAuth>;
}): RestFuzzExecutor {
  return async (operation, options) => {
    observeTransport(options, 'not-attempted');
    let auth = await authProvider.authForCall();
    observeTransport(options, 'unknown');
    const observation = retryObservation(options);
    const first = await base(
      operation,
      mergeAuthIntoOptions(
        {
          ...options,
          onTransportState: observation.first,
        },
        auth,
      ),
    );
    if (first.status !== 401) {
      return first;
    }

    try {
      auth = await authProvider.singleFlightRefresh();
    } catch {
      return first;
    }

    if (auth.authFailed) {
      return first;
    }

    observation.retry('unknown');
    return base(
      operation,
      mergeAuthIntoOptions(
        {
          ...options,
          onTransportState: observation.retry,
        },
        auth,
      ),
    );
  };
}
