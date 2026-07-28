/**
 * Branded ID types — compile-time prevention of wrong-ID-type bugs.
 *
 * Every platform ID (tenant, runner, scan) is a plain string at runtime
 * but a distinct type at compile time. Passing a TenantId where a RunnerId
 * is expected is a compile error.
 *
 * Branding happens at trust boundaries only — JWT extraction, route param
 * parsing, DB row mapping. Internal code passes the branded type; no raw
 * string threading.
 */

/** Intersect a base type with a unique phantom brand. */
type Brand<T, B extends string> = T & { readonly __brand: B };

/** Tenant identifier — scoped to a single customer org. */
export type TenantId = Brand<string, 'TenantId'>;

/** Runner identifier — a registered scan execution agent. */
export type RunnerId = Brand<string, 'RunnerId'>;

/** Scan identifier — a single pipeline execution. */
export type ScanId = Brand<string, 'ScanId'>;

// ── Boundary assertion helpers ──────────────────────────────
// Call these at trust boundaries only: JWT claim parsing, route param
// extraction, DB row mapping, UUID generation. Internal code receives
// the branded type — never calls these.

/** Brand a raw string as TenantId after trust-boundary validation. */
export const asTenantId = (s: string): TenantId => s as TenantId;

/** Brand a raw string as RunnerId after trust-boundary validation. */
export const asRunnerId = (s: string): RunnerId => s as RunnerId;

/** Brand a raw string as ScanId after trust-boundary validation. */
export const asScanId = (s: string): ScanId => s as ScanId;
