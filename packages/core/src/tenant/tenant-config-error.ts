/**
 * Typed tenant/config resolution errors for honest CLI exit classification (#241).
 */

import type { DinoErrorCode } from '../errors';

export type TenantConfigErrorKind = 'config' | 'usage';

/** The stable Dino code for a tenant-config failure, by kind. */
export function tenantConfigCode(kind: TenantConfigErrorKind): DinoErrorCode {
  // config → the caller's configuration is wrong (400 CONFIG_INVALID); usage → a flag/argument
  // value is wrong (400 INVALID_FIELD). Both keep the CLI kind they already classify to.
  return kind === 'usage' ? 'INVALID_FIELD' : 'CONFIG_INVALID';
}

export class TenantConfigError extends Error {
  readonly kind: TenantConfigErrorKind;
  /** Carried into the CLI error envelope so the same identity HTTP sends is visible on the CLI. */
  readonly code: DinoErrorCode;

  constructor(message: string, kind: TenantConfigErrorKind, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TenantConfigError';
    this.kind = kind;
    this.code = tenantConfigCode(kind);
  }
}

export function isTenantConfigError(err: unknown): err is TenantConfigError {
  return err instanceof TenantConfigError;
}
