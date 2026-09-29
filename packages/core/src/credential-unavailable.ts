/**
 * A tenant credential Dino could not obtain: the provider rejected it (config) or could not be reached (transient).
 *
 * With `TenantConfigError` (a credential that is missing or misconfigured), it is one of the two errors that abort a
 * scan instead of being recorded against one tool: a scan that cannot authenticate as the tenant asked must not
 * finish as a partial result, and a rejected secret must never become a finding against the target (#2635).
 */

import { DinoUpstreamError } from './errors';
import { isTenantConfigError } from './tenant/tenant-config-error';

export type CredentialFailureCode = 'OAUTH2_EXCHANGE_FAILED' | 'UPSTREAM_FAILED';

export class CredentialUnavailableError extends DinoUpstreamError {
  constructor(code: CredentialFailureCode, message: string, options?: { cause?: unknown }) {
    super(code, message, undefined, options);
    this.name = 'CredentialUnavailableError';
  }
}

/** An HTTP status a provider may answer differently on a later attempt. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** The provider answered with this status: a transient outage, or a refusal of the credential itself. */
export function credentialFailureForStatus(status: number, message: string): CredentialUnavailableError {
  return new CredentialUnavailableError(isTransientHttpStatus(status) ? 'UPSTREAM_FAILED' : 'OAUTH2_EXCHANGE_FAILED', message);
}

/** The errors that end a scan rather than one tool: a credential that is misconfigured or cannot be obtained. */
export function isScanAbortingError(err: unknown): boolean {
  return isTenantConfigError(err) || err instanceof CredentialUnavailableError;
}
