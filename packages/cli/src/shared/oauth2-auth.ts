/**
 * #2161 — flat-config OAuth2 client_credentials resolution for local CLI scans.
 * Async acquisition at the discovery boundary; secrets stay in env vars.
 */

import { acquireClientCredentialsToken } from '@dino/engine';
import { CliError } from './errors';
import type { DinoCliConfig } from '../config/loader';

/** Flat oauth2 descriptor stashed by sync buildContext; acquired async via resolveAuthHeaders. */
export interface OAuth2AuthDescriptor {
  tokenEndpoint: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  scope?: string | undefined;
}

/** Minimal context slice used by resolveAuthHeaders (avoids circular import with base-command). */
export interface OAuth2AuthContext {
  authHeaders?: Record<string, string> | undefined;
  oauth2Auth?: OAuth2AuthDescriptor | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export function oauth2DescriptorFromConfig(
  config: DinoCliConfig | null,
): OAuth2AuthDescriptor | undefined {
  const auth = config?.auth;
  if (!auth || !('type' in auth) || auth.type !== 'oauth2') {
    return undefined;
  }
  return {
    tokenEndpoint: auth.tokenEndpoint,
    clientIdEnv: auth.clientIdEnv,
    clientSecretEnv: auth.clientSecretEnv,
    ...(auth.scope ? { scope: auth.scope } : {}),
  };
}

/**
 * Resolve auth headers for discovery + scan.
 * Returns sync header-token headers when already set; otherwise acquires oauth2
 * client_credentials once, memoizes on context.authHeaders, and returns the map.
 */
export async function resolveAuthHeaders(
  context: OAuth2AuthContext,
): Promise<Record<string, string> | undefined> {
  if (context.authHeaders) {
    return context.authHeaders;
  }

  const oauth2 = context.oauth2Auth;
  if (!oauth2) {
    return undefined;
  }

  const clientId = process.env[oauth2.clientIdEnv];
  if (!clientId) {
    throw new CliError(
      `Auth env var "${oauth2.clientIdEnv}" is not set.`,
      1,
      `export ${oauth2.clientIdEnv}=<client-id> then re-run.`,
    );
  }
  const clientSecret = process.env[oauth2.clientSecretEnv];
  if (!clientSecret) {
    throw new CliError(
      `Auth env var "${oauth2.clientSecretEnv}" is not set.`,
      1,
      `export ${oauth2.clientSecretEnv}=<client-secret> then re-run.`,
    );
  }

  try {
    const result = await acquireClientCredentialsToken({
      tokenEndpoint: oauth2.tokenEndpoint,
      clientId,
      clientSecret,
      ...(oauth2.scope ? { scope: oauth2.scope } : {}),
      ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
    });
    context.authHeaders = { Authorization: `Bearer ${result.accessToken}` };
    return context.authHeaders;
  } catch (err: unknown) {
    if (err instanceof CliError) throw err;
    const msg = err instanceof Error ? err.message : 'OAuth2 token acquisition failed';
    throw new CliError(msg, 1, 'Check tokenEndpoint and client credentials env vars, then re-run.');
  }
}
