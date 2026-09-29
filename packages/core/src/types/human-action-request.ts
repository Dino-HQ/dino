/**
 * Human Action Request (HAR) — a durable request for the minimum human contribution Dino needs before
 * work can safely or correctly continue (DIN-1354; Presentation & Agent spec "Human Action Request and
 * durable resumption"; Machine Response contract §15, §17).
 *
 * Dino knows → Dino acts. Dino is uncertain → a HAR asks. Dino needs authority → a HAR requests
 * authorization. Authorization is one action type under the umbrella, not the umbrella itself.
 *
 * Two orthogonal axes, paired by a closed registry:
 * - `HumanContributionKind` (locked, MR §17) — the authority level of the contribution.
 * - `HarActionType` — the shape of the human's response.
 * Every HAR is created from a registered entry; nothing combines them freely. A HAR never requests,
 * stores or echoes a secret value: a credential HAR asks the human to authorize a Credential Reference
 * that the Secret Custodian already holds.
 */

import { z } from 'zod';
import type { CheckpointId, HumanActionRequestId, PresentationRequestId } from './ids';
import { parseHumanActionRequestId, parsePresentationRequestId } from './ids';
import type { DinoPermission } from './member';

export const HUMAN_ACTION_REQUEST_STATUSES = [
  'PENDING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type HumanActionRequestStatus = (typeof HUMAN_ACTION_REQUEST_STATUSES)[number];

/** `PENDING` moves exactly once, to a terminal status. A terminal HAR never changes again. */
export function canTransitionHumanActionRequest(
  from: HumanActionRequestStatus,
  to: HumanActionRequestStatus,
): boolean {
  return from === 'PENDING' && to !== 'PENDING';
}

export const HUMAN_CONTRIBUTION_KINDS = [
  'non_secret_fact',
  'consequential_authorization',
  'provider_atomic_action',
] as const;
export type HumanContributionKind = (typeof HUMAN_CONTRIBUTION_KINDS)[number];

/** `decide` answers approve or reject: two answers to one request, not two request types. */
export const HAR_ACTION_TYPES = [
  'provide_input',
  'confirm',
  'choose',
  'decide',
  'authorize',
] as const;
export type HarActionType = (typeof HAR_ACTION_TYPES)[number];

/** The fixed pairing of action type to authority level. */
export const HAR_ACTION_CONTRIBUTION: { readonly [A in HarActionType]: HumanContributionKind } = {
  provide_input: 'non_secret_fact',
  confirm: 'non_secret_fact',
  choose: 'non_secret_fact',
  decide: 'consequential_authorization',
  authorize: 'consequential_authorization',
};

/** Steps a HAR can block. Each belongs to exactly one continuation definition. */
export const PRESENTATION_STEP_IDS = [
  'admit_estate',
  'credential_setup',
  'connection_authorization',
] as const;
export type PresentationStepId = (typeof PRESENTATION_STEP_IDS)[number];

/** Why a NextAction is offered. Explains the action; grants no authority. Adding one is a contract change. */
export const PRESENTATION_REASON_CODES = [
  'credential_authorization_required',
  'credential_authorization_superseded',
  'request_in_progress',
  'human_action_expired',
  'target_connection_authorization_required',
] as const;
export type PresentationReasonCode = (typeof PRESENTATION_REASON_CODES)[number];

export const CREDENTIAL_REFERENCE_ID_PATTERN =
  /^cref_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A human decides a proposed Target Connection version: authorize it, or decline it (it is then retired). */
const TargetConnectionAuthorizationResponseSchema = z
  .object({ decision: z.enum(['authorize', 'decline']) })
  .strict();

const TargetCredentialAuthorizationResponseSchema = z
  .object({ credentialReferenceId: z.string().regex(CREDENTIAL_REFERENCE_ID_PATTERN) })
  .strict();

export interface HarRegistryEntry {
  readonly id: string;
  readonly actionType: HarActionType;
  readonly contributionKind: HumanContributionKind;
  readonly blockedStepId: PresentationStepId;
  readonly reasonCode: PresentationReasonCode;
  /** The respondent's live grant must hold this at every submission. */
  readonly requiredPermission: DinoPermission;
  readonly ttlSeconds: number;
  /** Recorded on each HAR so an expiry decision names the rule it was made under. */
  readonly clockRuleVersion: string;
  readonly responseSchemaId: string;
  readonly responseSchema: z.ZodType<Record<string, unknown>>;
  readonly missingContribution: string;
  readonly whyRequired: string;
  readonly constraints: readonly string[];
  /** Syntactically representative, semantically inert: it never passes `responseSchema`. */
  readonly example: Record<string, unknown>;
}

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export const HAR_REGISTRY = {
  target_credential_authorization: {
    id: 'target_credential_authorization',
    actionType: 'authorize',
    contributionKind: HAR_ACTION_CONTRIBUTION.authorize,
    blockedStepId: 'credential_setup',
    reasonCode: 'credential_authorization_required',
    requiredPermission: 'api:update',
    ttlSeconds: SEVEN_DAYS_SECONDS,
    clockRuleVersion: 'har-expiry-v1',
    responseSchemaId: 'dino.har.target_credential_authorization.v1',
    responseSchema: TargetCredentialAuthorizationResponseSchema,
    missingContribution:
      'Authorize the Credential Reference Dino uses to authenticate to this Target.',
    whyRequired:
      'Dino cannot choose which credential represents the Target on its own; a human with api:update must authorize one.',
    constraints: [
      'credentialReferenceId names an existing Credential Reference of this Organization',
      'the reference is bound to this Target with purpose target_authentication',
      'the reference has an active version and is linked to an auth profile for this Target',
      'send the reference id only, never a secret value',
    ],
    example: { credentialReferenceId: 'cref_<credential-reference-id>' },
  },
  target_connection_authorization: {
    id: 'target_connection_authorization',
    actionType: 'authorize',
    contributionKind: HAR_ACTION_CONTRIBUTION.authorize,
    blockedStepId: 'connection_authorization',
    reasonCode: 'target_connection_authorization_required',
    requiredPermission: 'api:update',
    ttlSeconds: SEVEN_DAYS_SECONDS,
    clockRuleVersion: 'har-expiry-v1',
    responseSchemaId: 'dino.har.target_connection_authorization.v1',
    responseSchema: TargetConnectionAuthorizationResponseSchema,
    missingContribution:
      'Authorize, or decline, the proposed Target Connection version: how and where Dino may reach this Target.',
    whyRequired:
      'A Target Connection permits Dino to interact with a customer Target under a credential; a human with api:update must authorize each version.',
    constraints: [
      'decision is authorize or decline',
      'the version must still be pending and configured against the current Target Definition',
      'every bound auth profile must still belong to this Target with a usable Credential Reference',
    ],
    example: { decision: '<authorize|decline>' },
  },
} as const satisfies Record<string, HarRegistryEntry>;

export type HarRegistryEntryId = keyof typeof HAR_REGISTRY;

export function harRegistryEntry(id: string): HarRegistryEntry | undefined {
  return Object.hasOwn(HAR_REGISTRY, id) ? HAR_REGISTRY[id as HarRegistryEntryId] : undefined;
}

export interface HarResumeTarget {
  readonly requestId: PresentationRequestId;
  readonly checkpointId: CheckpointId;
  readonly stepId: PresentationStepId;
}

/** The immutable Human Handoff Contract every HAR carries (MR §17). It does not decide who may respond. */
export interface HumanHandoffContract {
  readonly harId: HumanActionRequestId;
  readonly actionType: HarActionType;
  readonly contributionKind: HumanContributionKind;
  readonly missingContribution: string;
  readonly whyRequired: string;
  readonly blockedStepId: PresentationStepId;
  readonly expectedResponse: {
    readonly schemaId: string;
    readonly constraints: readonly string[];
    readonly example: Readonly<Record<string, unknown>>;
  };
  readonly resume: HarResumeTarget;
}

export function buildHumanHandoffContract(
  entry: HarRegistryEntry,
  harId: HumanActionRequestId,
  resume: HarResumeTarget,
): HumanHandoffContract {
  return {
    harId,
    actionType: entry.actionType,
    contributionKind: entry.contributionKind,
    missingContribution: entry.missingContribution,
    whyRequired: entry.whyRequired,
    blockedStepId: entry.blockedStepId,
    expectedResponse: {
      schemaId: entry.responseSchemaId,
      constraints: entry.constraints,
      example: entry.example,
    },
    resume,
  };
}

/** The accepted response, as recorded. Carries provenance, never secret material. */
export interface HarAcceptedResponse {
  readonly respondentType: 'human';
  readonly respondentId: string;
  readonly delegated: boolean;
  readonly response: Readonly<Record<string, unknown>>;
  readonly acceptedAt: string;
}

/** Transport-neutral HAR projection: HTTP and MCP return exactly this. */
export interface HumanActionRequestView {
  readonly harId: HumanActionRequestId;
  readonly requestId: PresentationRequestId;
  readonly registryEntry: HarRegistryEntryId;
  readonly status: HumanActionRequestStatus;
  readonly handoff: HumanHandoffContract;
  readonly targetId: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly statusChangedAt: string | null;
  readonly supersedesHarId: HumanActionRequestId | null;
  readonly acceptedResponse: HarAcceptedResponse | null;
}

// ── Safe next actions (MR §15 subset) ─────────────────────────────────────

export type PresentationNextAction = { readonly reasonCode: PresentationReasonCode } & (
  | { readonly kind: 'complete_har'; readonly harId: HumanActionRequestId }
  | { readonly kind: 'poll_request'; readonly requestId: PresentationRequestId }
  /**
   * Invoke a registered Dino capability with arguments Dino already validated (MR §15). Offered for
   * `presentation_request.reopen` when the HAR a Request waits on expired unanswered.
   */
  | {
      readonly kind: 'invoke_capability';
      readonly capabilityId: InvokableCapabilityId;
      readonly arguments: ValidatedCapabilityArguments;
    }
);

/** The capabilities a NextAction may name (MR §15 `invoke_capability`). Adding one is a contract change. */
export const INVOKABLE_CAPABILITIES = {
  'presentation_request.reopen': {
    schemaId: 'dino.presentation_request.reopen',
    schemaVersion: '1',
  },
} as const;
export type InvokableCapabilityId = keyof typeof INVOKABLE_CAPABILITIES;

/** MR §15: arguments admitted by the capability's schema, bound by a digest of their canonical form. */
export interface ValidatedCapabilityArguments {
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly value: Readonly<Record<string, unknown>>;
  /** SHA-256 hex of {@link canonicalCapabilityValue}; revalidated where the capability is invoked. */
  readonly digest: string;
}

/** The canonical serialization a capability argument digest is computed over (keys sorted). */
export function canonicalCapabilityValue(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((k) => [k, value[k]]),
  );
}

/** SHA-256 hex of {@link canonicalCapabilityValue}: the digest that binds a capability's arguments. */
export async function capabilityArgumentsDigest(
  value: Readonly<Record<string, unknown>>,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCapabilityValue(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ReopenArgumentsSchema = z
  .object({
    schemaId: z.literal(INVOKABLE_CAPABILITIES['presentation_request.reopen'].schemaId),
    schemaVersion: z.literal(INVOKABLE_CAPABILITIES['presentation_request.reopen'].schemaVersion),
    value: z.object({ requestId: z.string() }).strict(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/**
 * Revalidate capability arguments at the invocation boundary (MR §15): they must match the capability's
 * registered schema and carry the digest of exactly their value. Parsing a NextAction only checks shape;
 * this is the integrity check. Returns the arguments, or undefined (fail closed).
 */
export async function verifyReopenArguments(
  args: unknown,
): Promise<
  (ValidatedCapabilityArguments & { readonly value: { readonly requestId: string } }) | undefined
> {
  const parsed = ReopenArgumentsSchema.safeParse(args);
  if (!parsed.success) return undefined;
  const digest = await capabilityArgumentsDigest(parsed.data.value);
  return digest === parsed.data.digest ? parsed.data : undefined;
}

/** The re-ask action for a Request whose HAR expired; `digest` is computed by the caller (async hashing). */
export function reopenAction(
  requestId: PresentationRequestId,
  digest: string,
): PresentationNextAction {
  const capability = INVOKABLE_CAPABILITIES['presentation_request.reopen'];
  return {
    kind: 'invoke_capability',
    capabilityId: 'presentation_request.reopen',
    arguments: {
      schemaId: capability.schemaId,
      schemaVersion: capability.schemaVersion,
      value: { requestId },
      digest,
    },
    reasonCode: 'human_action_expired',
  };
}

const reasonCodeSchema = z.enum(PRESENTATION_REASON_CODES);
const PresentationNextActionSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('complete_har'), harId: z.string(), reasonCode: reasonCodeSchema })
    .strict(),
  z
    .object({
      kind: z.literal('poll_request'),
      requestId: z.string(),
      reasonCode: reasonCodeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('invoke_capability'),
      capabilityId: z.literal('presentation_request.reopen'),
      arguments: ReopenArgumentsSchema,
      reasonCode: reasonCodeSchema,
    })
    .strict(),
]);

/**
 * Validate an untrusted value as a PresentationNextAction by SHAPE; anything else → undefined (fail closed).
 * An `invoke_capability` digest is checked by {@link verifyReopenArguments} where the capability is invoked.
 */
export function parsePresentationNextAction(value: unknown): PresentationNextAction | undefined {
  const parsed = PresentationNextActionSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const action = parsed.data;
  if (action.kind === 'complete_har') {
    const harId = parseHumanActionRequestId(action.harId);
    return harId === undefined
      ? undefined
      : { kind: 'complete_har', harId, reasonCode: action.reasonCode };
  }
  if (action.kind === 'invoke_capability') {
    const requestId = parsePresentationRequestId(action.arguments.value.requestId);
    return requestId === undefined ? undefined : reopenAction(requestId, action.arguments.digest);
  }
  const requestId = parsePresentationRequestId(action.requestId);
  return requestId === undefined
    ? undefined
    : { kind: 'poll_request', requestId, reasonCode: action.reasonCode };
}

// ── Surface arguments (shared by HTTP and MCP adapters) ───────────────────

/** A Presentation Request named by id (MCP tool argument). */
export const PresentationRequestRefSchema = z
  .object({ requestId: z.string().trim().min(1).max(128) })
  .strict();

/** A Human Action Request named by id (MCP tool argument). */
export const HumanActionRequestRefSchema = z
  .object({ harId: z.string().trim().min(1).max(128) })
  .strict();

/**
 * A response to a Human Action Request: the resume target echoed from its handoff contract and the response
 * its `expectedResponse` describes. The idempotency key binds a retry to the same submission.
 */
export const HarSubmissionCommandSchema = z
  .object({
    harId: z.string().trim().min(1).max(128),
    idempotencyKey: z.string().trim().min(1).max(255),
    resume: z
      .object({ requestId: z.string(), checkpointId: z.string(), stepId: z.string() })
      .strict(),
    response: z.record(z.string(), z.unknown()),
  })
  .strict();
export type HarSubmissionCommand = z.infer<typeof HarSubmissionCommandSchema>;

/** Reopen a Presentation Request: the `invoke_capability` arguments its next action offered (MCP argument). */
export const PresentationReopenCommandSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
