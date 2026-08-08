/**
 * #2160 — assemble static auth headers from CLI flags + flat `.dino.yml` auth.
 */

import { CliError } from './errors';
import { requireStringFlag } from './require-string-flag';
import type { CommonFlags } from './base-command';
import type { DinoCliConfig } from '../config/loader';

/**
 * Parse a single `--header "Name: Value"` argument.
 * Split on the first `:`, trim both sides; reject missing colon / empty name.
 * Do not echo `raw` in the error (may contain a fat-fingered secret).
 */
export function parseHeaderArg(raw: string): Record<string, string> {
  const idx = raw.indexOf(':');
  if (idx <= 0) {
    throw new CliError(
      'Invalid --header: expected `Name: Value` (e.g. --header "Authorization: Bearer <token>").',
      1,
      'Example: --header "Authorization: Bearer tok" or --header "X-API-Key: secret"',
    );
  }
  const name = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (name.length === 0) {
    throw new CliError(
      'Invalid --header: expected `Name: Value` (e.g. --header "Authorization: Bearer <token>").',
      1,
      'Example: --header "Authorization: Bearer tok" or --header "X-API-Key: secret"',
    );
  }
  return { [name]: value };
}

function resolveFlatHeaderAuth(
  auth: Extract<NonNullable<DinoCliConfig['auth']>, { type: 'header' }>,
): Record<string, string> {
  const raw = process.env[auth.valueEnv];
  if (raw === undefined || raw === '') {
    throw new CliError(
      `Auth env var "${auth.valueEnv}" is not set.`,
      1,
      `export ${auth.valueEnv}=<your-token> then re-run.`,
    );
  }
  const useScheme = auth.scheme !== undefined && auth.scheme.length > 0;
  return { [auth.header]: useScheme ? `${auth.scheme} ${raw}` : raw };
}

function headerArgsFromFlags(headerFlag: CommonFlags['header']): string[] {
  if (headerFlag === undefined) return [];
  if (Array.isArray(headerFlag)) return headerFlag;
  return [headerFlag];
}

function applyFlagHeaders(flags: CommonFlags, headers: Record<string, string>): void {
  const token = requireStringFlag('--token', flags.token, {
    requires: 'a token value (e.g. --token <jwt-or-api-key>).',
    hint: 'Pass the token immediately after the flag, or use --header "Authorization: Bearer <token>".',
  });
  // token already validated non-empty by requireStringFlag
  if (typeof token === 'string') {
    headers.Authorization = `Bearer ${token}`;
  }

  for (const arg of headerArgsFromFlags(flags.header)) {
    if (typeof arg !== 'string' || arg.length === 0) {
      throw new CliError(
        '--header requires a `Name: Value` string.',
        1,
        'Example: --header "Authorization: Bearer tok"',
      );
    }
    Object.assign(headers, parseHeaderArg(arg));
  }
}

/**
 * Assemble static auth headers from CLI flags + flat `.dino.yml` auth.
 * Precedence: flags first (`--token`, then `--header`); flat header applies only when
 * that header name is not already set by a flag (flags win; skip env read/throw on override).
 * Returns undefined when nothing configured. Throws CliError on malformed/unresolved credential.
 */
export function buildAuthHeaders(
  flags: CommonFlags,
  config: DinoCliConfig | null,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  applyFlagHeaders(flags, headers);

  const auth = config?.auth;
  if (auth !== undefined && 'type' in auth && auth.type === 'header') {
    // Same-name flag override: do not read valueEnv / do not throw.
    if (!(auth.header in headers)) {
      Object.assign(headers, resolveFlatHeaderAuth(auth));
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}
