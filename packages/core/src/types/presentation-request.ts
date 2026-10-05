/**
 * Presentation Request and Checkpoint — the durable parent of every Human Action Request (DIN-1354).
 *
 * Locked by the Presentation & Agent layer spec ("Surface contract, Presentation Request, and Interaction
 * Envelope") and the Machine Response contract §16. A Presentation Request exists only after
 * authentication, authorization, tenancy, input and idempotency admission; its status is append-only and
 * independent of any downstream Run, Verdict or readiness. A Checkpoint is the Request's continuation
 * state: immutable versions, the current one a projection. Neither ever carries secret material.
 */

import type { HumanActionRequestView, PresentationNextAction } from './human-action-request';
import { HAR_REGISTRY, reopenAction } from './human-action-request';
import type {
  CheckpointId,
  CheckpointVersionId,
  HumanActionRequestId,
  PresentationRequestId,
} from './ids';

export const PRESENTATION_REQUEST_STATUSES = [
  'ACCEPTED',
  'IN_PROGRESS',
  'AWAITING_HUMAN',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type PresentationRequestStatus = (typeof PRESENTATION_REQUEST_STATUSES)[number];

/** The only legal status moves. A move not listed here is refused, never coerced. */
export const PRESENTATION_REQUEST_TRANSITIONS: {
  readonly [S in PresentationRequestStatus]: readonly PresentationRequestStatus[];
} = {
  ACCEPTED: ['IN_PROGRESS', 'FAILED', 'CANCELLED'],
  IN_PROGRESS: ['AWAITING_HUMAN', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  AWAITING_HUMAN: ['IN_PROGRESS', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isPresentationRequestStatus(v: unknown): v is PresentationRequestStatus {
  return typeof v === 'string' && (PRESENTATION_REQUEST_STATUSES as readonly string[]).includes(v);
}

export function canTransitionPresentationRequest(
  from: PresentationRequestStatus,
  to: PresentationRequestStatus,
): boolean {
  return PRESENTATION_REQUEST_TRANSITIONS[from].includes(to);
}

export function isTerminalPresentationRequestStatus(s: PresentationRequestStatus): boolean {
  return PRESENTATION_REQUEST_TRANSITIONS[s].length === 0;
}

/** Capabilities that admit a Presentation Request. Adding one is a contract change. */
export const PRESENTATION_CAPABILITIES = [
  'organization_api.bootstrap',
  'target_connection.authorize',
] as const;
export type PresentationCapability = (typeof PRESENTATION_CAPABILITIES)[number];

/** A canonical artifact the Request has already created; resume never re-creates it. */
export interface CanonicalArtifactReference {
  readonly type:
    | 'api'
    | 'environment'
    | 'target'
    | 'target_definition'
    | 'auth_profile'
    | 'credential_reference'
    | 'target_connection';
  readonly id: string;
  readonly version?: number;
}

/** One immutable Checkpoint version (MR §16). */
export interface CheckpointSnapshot {
  readonly checkpointId: CheckpointId;
  readonly checkpointVersionId: CheckpointVersionId;
  readonly version: number;
  readonly requestId: PresentationRequestId;
  readonly continuationDefinitionVersion: string;
  readonly completedStepIds: readonly string[];
  readonly pendingStepIds: readonly string[];
  readonly createdArtifactReferences: readonly CanonicalArtifactReference[];
  readonly activeHarIds: readonly HumanActionRequestId[];
  readonly lastSafeTransitionId: string;
  readonly revalidationRequirementIds: readonly string[];
  readonly supersedesCheckpointVersionId?: CheckpointVersionId;
  readonly createdAt: string;
}

/** Transport-neutral Request projection: HTTP, MCP and the CLI read exactly this. */
export interface PresentationRequestView {
  readonly requestId: PresentationRequestId;
  readonly capability: PresentationCapability;
  readonly status: PresentationRequestStatus;
  readonly contractVersion: number;
  readonly createdAt: string;
  readonly statusChangedAt: string;
  readonly checkpoint: CheckpointSnapshot;
  readonly humanActionRequests: readonly HumanActionRequestView[];
  /** Absent when Dino cannot currently state a safe action; there is no `none`. */
  readonly nextAction?: PresentationNextAction;
}

/** The Organization's Requests, newest first and bounded; each is the same projection a single read returns. */
export interface PresentationRequestListView {
  readonly items: readonly PresentationRequestView[];
  readonly count: number;
  /** Pass as `cursor` for the next, older page; null when there is none. */
  readonly nextCursor: string | null;
}

/** What the next action reads of each HAR. */
export type HarForNextAction = Pick<
  HumanActionRequestView,
  'harId' | 'status' | 'expiresAt' | 'supersedesHarId' | 'registryEntry'
>;

/** A HAR that re-asks after expiry asks the same question; one superseding a revoked answer says so. */
function completeReason(
  pending: HarForNextAction,
  hars: readonly HarForNextAction[],
): PresentationNextAction['reasonCode'] {
  if (pending.supersedesHarId === null) return HAR_REGISTRY[pending.registryEntry].reasonCode;
  const superseded = hars.find((h) => h.harId === pending.supersedesHarId);
  return superseded?.status === 'EXPIRED'
    ? HAR_REGISTRY[pending.registryEntry].reasonCode
    : 'credential_authorization_superseded';
}

/**
 * The one safe next action for a Request, derived from its status and HARs at `now`. Pure, so every surface
 * derives the same action from the same state. A PENDING HAR past its deadline is expired whether or not the
 * sweep has marked it yet (submission refuses it, and reopen expires it first), so it is never offered.
 */
export function derivePresentationNextAction(
  status: PresentationRequestStatus,
  requestId: PresentationRequestId,
  hars: readonly HarForNextAction[],
  at: {
    readonly now: Date;
    /** SHA-256 hex of the re-ask arguments ({@link canonicalCapabilityValue}); without it none is offered. */
    readonly reopenDigest?: string | undefined;
  },
): PresentationNextAction | undefined {
  const { now, reopenDigest } = at;
  if (status === 'AWAITING_HUMAN') {
    const due = (h: HarForNextAction) => h.status === 'PENDING' && Date.parse(h.expiresAt) <= now.getTime();
    const pending = hars.find((h) => h.status === 'PENDING' && !due(h));
    if (pending === undefined) {
      // Waiting with nothing to answer: the last HAR expired unanswered (marked or due), so the next step is to re-ask.
      return (hars.at(-1)?.status === 'EXPIRED' || hars.some(due)) && reopenDigest !== undefined
        ? reopenAction(requestId, reopenDigest)
        : undefined;
    }
    return {
      kind: 'complete_har',
      harId: pending.harId,
      reasonCode: completeReason(pending, hars),
    };
  }
  if (status === 'ACCEPTED' || status === 'IN_PROGRESS') {
    return { kind: 'poll_request', requestId, reasonCode: 'request_in_progress' };
  }
  return undefined;
}
