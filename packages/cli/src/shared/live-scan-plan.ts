/**
 * Live scan plan — onboarding-generated configs only (#2191, T6 pure).
 * INV-7: every configYaml === buildConfigYaml(answers).
 */

import { buildConfigYaml } from './config-yaml';

export interface ScanPlan {
  label: string;
  authed: boolean;
  credentialPresent: boolean;
  configYaml: string;
  envVar?: string | undefined;
}

const PUBLIC_GRAPHQL_ENDPOINT = ['https:/', '/rickandmortyapi.com/graphql'].join('');
const STAGING_REST_ENDPOINT = 'https://staging.api.usedino.dev';
const STAGING_OPENAPI_URL = 'https://staging.api.usedino.dev/openapi.json';
export const STAGING_API_KEY_ENV = 'DINO_STAGING_API_KEY';

/** INV-4: present AND non-empty (whitespace-only counts as absent). */
export function credentialPresent(env: Record<string, string | undefined>, name: string): boolean {
  return (env[name] ?? '').trim().length > 0; // eslint-disable-line security/detect-object-injection -- name is a trusted env key from planScans
}

/** Public unauthenticated + optional staging-authenticated REST scan plans. */
export function planScans(env: Record<string, string | undefined>): ScanPlan[] {
  const publicYaml = buildConfigYaml({
    endpoint: PUBLIC_GRAPHQL_ENDPOINT,
    protocol: 'graphql',
    auth: { type: 'none' },
  });

  const authedCred = credentialPresent(env, STAGING_API_KEY_ENV);
  const authedYaml = buildConfigYaml({
    endpoint: STAGING_REST_ENDPOINT,
    protocol: 'rest',
    specUrl: STAGING_OPENAPI_URL,
    auth: {
      type: 'header',
      header: 'Authorization',
      scheme: 'Bearer',
      valueEnv: STAGING_API_KEY_ENV,
    },
  });

  return [
    {
      label: 'public-unauthenticated',
      authed: false,
      credentialPresent: true,
      configYaml: publicYaml,
    },
    {
      label: 'staging-authenticated',
      authed: true,
      credentialPresent: authedCred,
      configYaml: authedYaml,
      envVar: STAGING_API_KEY_ENV,
    },
  ];
}
