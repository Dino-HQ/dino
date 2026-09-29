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

/** Presentation Request identifier (`preq_…`) — one admitted surface interaction (MR §8). */
export type PresentationRequestId = Brand<string, 'PresentationRequestId'>;

/** Checkpoint identifier (`ckp_…`) — the durable continuation state of one Presentation Request. */
export type CheckpointId = Brand<string, 'CheckpointId'>;

/** Checkpoint version identifier (`ckv_…`) — one immutable Checkpoint snapshot. */
export type CheckpointVersionId = Brand<string, 'CheckpointVersionId'>;

/** Human Action Request identifier (`har_…`). */
export type HumanActionRequestId = Brand<string, 'HumanActionRequestId'>;

const minted = (prefix: string) => new RegExp(`^${prefix}_[0-9a-f]{48}$`);
const PRESENTATION_REQUEST_ID = minted('preq');
const CHECKPOINT_ID = minted('ckp');
const CHECKPOINT_VERSION_ID = minted('ckv');
const HUMAN_ACTION_REQUEST_ID = minted('har');

/** Syntax-only parsers for Dino-minted identities; tenant and existence checks stay with the caller. */
export function parsePresentationRequestId(s: string): PresentationRequestId | undefined {
  return PRESENTATION_REQUEST_ID.test(s) ? (s as PresentationRequestId) : undefined;
}

export function parseCheckpointId(s: string): CheckpointId | undefined {
  return CHECKPOINT_ID.test(s) ? (s as CheckpointId) : undefined;
}

export function parseCheckpointVersionId(s: string): CheckpointVersionId | undefined {
  return CHECKPOINT_VERSION_ID.test(s) ? (s as CheckpointVersionId) : undefined;
}

export function parseHumanActionRequestId(s: string): HumanActionRequestId | undefined {
  return HUMAN_ACTION_REQUEST_ID.test(s) ? (s as HumanActionRequestId) : undefined;
}
