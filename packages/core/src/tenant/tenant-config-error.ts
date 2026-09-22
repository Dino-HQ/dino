/**
 * Typed tenant/config resolution errors for honest CLI exit classification (#241).
 */

export type TenantConfigErrorKind = 'config' | 'usage';

export class TenantConfigError extends Error {
  readonly kind: TenantConfigErrorKind;

  constructor(message: string, kind: TenantConfigErrorKind, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TenantConfigError';
    this.kind = kind;
  }
}

export function isTenantConfigError(err: unknown): err is TenantConfigError {
  return err instanceof TenantConfigError;
}
