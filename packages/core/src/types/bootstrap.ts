/**
 * Bootstrap Request + Admitted Outcome — domain contract for the authorized Organization/API estate
 * bootstrap (P1A / DIN-1348, extended by P1B / DIN-1349).
 *
 * SCOPE: one coherent configuration graph — Organization, a stable API identity, one Customer
 * Environment, one Target, and that Target's first immutable Target Definition — admitted atomically
 * under a single Bootstrap Request. This is IDENTITY + versioned INTENT only. It asserts nothing about
 * reachability, health, discovery, Target State, or serving reality (ADR-0071), and carries NO
 * credential, Target Connection authorization, or Secret Custody material — those remain DIN-1256 work.
 *
 * NAMING NOTE: "Bootstrap Request" and "request digest" are P1A-LOCAL implementation names, NOT
 * canonical Dino architecture terms. Their semantics are bound to:
 *   - Idempotency Identity (ADR-0056): identity = authenticated Organization Principal + Organization
 *     + action + idempotency key + normalized request semantics. Dino mints the identity, never the
 *     caller. The principal is PART of the identity, so two principals sharing a key never collide.
 *     Reusing a key with DIFFERENT semantics is a typed conflict.
 *   - Immutable bounded request (ADR-0092): the admitted request/outcome is immutable once accepted.
 *   - Digest-for-integrity-not-identity (CONTEXT.md Observation): the request digest proves semantic
 *     equivalence on replay; it does NOT define identity.
 *
 * The Admitted Outcome is the immutable Canonical Artifact (ADR-0054/0068/0086) recorded durably
 * inside the same atomic admission transaction as the API it names. Provenance carries the
 * authenticated principal and a nullable Delegation Context slot per ADR-0036.
 *
 * This is the product contract. The @dino/cloud Drizzle table (`bootstrap_requests`) is the storage
 * shape and lives there; digest/id hashing uses the cloud `stableId` primitive.
 */

import { z } from 'zod';

/**
 * Versioned Bootstrap Request contract. Bump when the admitted-outcome shape changes (ADR-0070).
 * v1 (P1A): Organization + API only. v2 (P1B): adds Customer Environment, Target, and the first
 * immutable Target Definition to the admitted graph.
 */
export const BOOTSTRAP_CONTRACT_VERSION = 2 as const;

/** The single canonical bootstrap action — the authorized Organization/API estate configuration graph. */
export const BOOTSTRAP_ACTION = 'organization_api.bootstrap' as const;
export type BootstrapAction = typeof BOOTSTRAP_ACTION;

/**
 * Environment Classification — the authorized semantic purpose of a Customer Environment
 * (CONTEXT.md / ADR-0071). Classification expresses intended governance, NOT runtime truth, and is
 * NEVER inferred from the Display Name: `staging` may be a Display Name but is not a Classification.
 */
export const ENVIRONMENT_CLASSIFICATIONS = [
  'DEVELOPMENT',
  'TESTING',
  'SANDBOX',
  'PRODUCTION',
] as const;
export const EnvironmentClassificationSchema = z.enum(ENVIRONMENT_CLASSIFICATIONS);
export type EnvironmentClassification = z.infer<typeof EnvironmentClassificationSchema>;

/**
 * Actor + delegation provenance recorded on the admitted outcome (ADR-0036). `delegation` is an opaque
 * nullable slot: P1A always records null (direct Organization Principal over HTTP). The delegated MCP
 * projection (P1C) owns the concrete Delegation Context shape — P1A only preserves the slot rather than
 * locking a contract it does not own.
 */
export const BootstrapProvenanceSchema = z.object({
  /** Authenticated principal class (e.g. 'member'). */
  actorType: z.string().min(1),
  /** Organization Principal identity (the memberProfileId), never the client surface. */
  actorId: z.string().min(1),
  /** Delegation Context when a surface acted on the principal's behalf; null for direct principal action. */
  delegation: z.union([z.record(z.string(), z.unknown()), z.null()]),
});
export type BootstrapProvenance = z.infer<typeof BootstrapProvenanceSchema>;

/** The stable admitted API identity (ADR-0071 — intent identity, not a URL/deployment). */
export const AdmittedApiSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: z.string().min(1),
});

/**
 * The stable admitted Customer Environment identity (CONTEXT.md / ADR-0071): an API-scoped boundary
 * with an Organization-authored Display Name and an explicit Classification. The Display Name is a
 * flexible label; the identity and the Classification are distinct from it.
 */
export const AdmittedEnvironmentSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  classification: EnvironmentClassificationSchema,
});

/** The stable admitted Target identity within one Environment (CONTEXT.md — a concrete deployment). */
export const AdmittedTargetSchema = z.object({
  id: z.string().min(1),
});

/**
 * The permitted destination/configuration SCOPE of a Target Definition (DIN-1349 item 3; CONTEXT.md
 * "permitted destination and connection configuration"). Bounded Organization INTENT only: the schemes
 * Dino is permitted to use and an optional path boundary. It is NOT a Target Connection — no ports,
 * redirect/credential-forwarding boundaries, request limits, or authentication (those are DIN-1256).
 */
export const TargetDefinitionScopeSchema = z.object({
  /** Non-empty subset of the permitted schemes; must include the destination's own scheme. */
  allowedSchemes: z.array(z.enum(['http', 'https'])).min(1),
  /** Optional permitted path boundary (e.g. '/v2'); null = the whole host is in scope. */
  pathPrefix: z.union([z.string().min(1), z.null()]),
});
export type TargetDefinitionScope = z.infer<typeof TargetDefinitionScopeSchema>;

/**
 * The admitted first Target Definition — immutable, versioned Organization intent describing the
 * Target's permitted destination + configuration scope (ADR-0071). It records intent only: never
 * reachability, connection authorization, or serving reality. A material change (destination OR scope)
 * mints a NEW version rather than rewriting this.
 */
export const AdmittedTargetDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  destinationUrl: z.string().min(1),
  scope: TargetDefinitionScopeSchema,
});

/**
 * The Canonical Artifact set admitted under one Bootstrap Request (v2): one coherent configuration
 * graph — API identity, Customer Environment, Target, and the Target's first immutable Target
 * Definition — all under the resolved Organization, recorded atomically (ADR-0054/0086).
 */
export const AdmittedArtifactsSchema = z.object({
  api: AdmittedApiSchema,
  environment: AdmittedEnvironmentSchema,
  target: AdmittedTargetSchema,
  targetDefinition: AdmittedTargetDefinitionSchema,
});
export type AdmittedArtifacts = z.infer<typeof AdmittedArtifactsSchema>;

/** The immutable admitted outcome — the durable canonical record replay returns verbatim. */
export const AdmittedOutcomeSchema = z.object({
  requestId: z.string().min(1),
  contractVersion: z.number().int().positive(),
  action: z.literal(BOOTSTRAP_ACTION),
  requestDigest: z.string().min(1),
  artifacts: AdmittedArtifactsSchema,
  provenance: BootstrapProvenanceSchema,
  admittedAt: z.string().min(1),
});
export type AdmittedOutcome = z.infer<typeof AdmittedOutcomeSchema>;

/**
 * Secret-free, deterministic normalization of a Bootstrap Request's semantics. The returned string is
 * the input to the request digest (ADR-0056 "normalized request semantics"). Every behavior-affecting
 * field of the admitted graph participates — API intent, Environment Display Name + Classification, and
 * the Target's destination intent — so reusing an idempotency key with any different content is a typed
 * conflict, not a silent replay. No secret material participates. Fixed key order + trimmed strings make
 * the digest stable across equivalent requests.
 */
export interface BootstrapSemanticsInput {
  api: { name: string; protocol?: string | undefined; description?: string | undefined };
  environment: { displayName: string; classification: EnvironmentClassification };
  target: { name?: string | undefined; destinationUrl: string; scope: TargetDefinitionScope };
}

/** Deterministic, order-independent scope for the digest — schemes sorted, path trimmed or null. */
export function normalizeTargetScope(scope: TargetDefinitionScope): {
  allowedSchemes: string[];
  pathPrefix: string | null;
} {
  return {
    allowedSchemes: [...scope.allowedSchemes].sort((a, b) => a.localeCompare(b)),
    pathPrefix: scope.pathPrefix === null ? null : scope.pathPrefix.trim(),
  };
}

export function normalizeBootstrapSemantics(input: BootstrapSemanticsInput): string {
  const canonical = {
    api: {
      name: input.api.name.trim(),
      protocol: input.api.protocol ?? 'rest',
      description: input.api.description ?? null,
    },
    environment: {
      displayName: input.environment.displayName.trim(),
      classification: input.environment.classification,
    },
    target: {
      name: input.target.name?.trim() ?? null,
      destinationUrl: input.target.destinationUrl.trim(),
      scope: normalizeTargetScope(input.target.scope),
    },
  };
  return JSON.stringify(canonical);
}

/**
 * The transport-NEUTRAL bootstrap command (DIN-1350). This is the single input the bootstrap application
 * service consumes; BOTH adapters construct the identical command — the HTTP adapter from its
 * TypeBox-validated body + `Idempotency-Key` header, the MCP tool from its validated call arguments — so
 * no bootstrap rule can exist in only one transport. It carries IDENTITY + versioned INTENT only: no
 * credential, Connection authorization, or scan trigger (those remain DIN-1256 / Discovery). The
 * `idempotencyKey` is client-supplied on both surfaces; Dino binds it to the authenticated Principal +
 * Organization to mint the canonical request identity (ADR-0056) — the same key from the same Principal
 * replays identically whether it arrived over HTTP or MCP (cross-transport convergence).
 */
/** The shared bound on a Bootstrap Request idempotency key. BOTH transports enforce it (HTTP validates
 *  the `Idempotency-Key` header against it; MCP validates the tool argument), so neither accepts a key the
 *  other would reject. */
export const BOOTSTRAP_IDEMPOTENCY_KEY_MAX = 255 as const;

export const BootstrapCommandSchema = z.object({
  api: z.object({
    name: z.string().min(1).max(255),
    protocol: z.enum(['rest', 'graphql']).optional(),
    description: z.string().max(1000).optional(),
  }),
  environment: z.object({
    displayName: z.string().min(1).max(255),
    classification: EnvironmentClassificationSchema,
  }),
  target: z.object({
    name: z.string().min(1).max(255).optional(),
    definition: z.object({
      destinationUrl: z.string().min(1).max(2048),
      allowedSchemes: z.array(z.enum(['http', 'https'])).min(1).max(2).optional(),
      pathPrefix: z.string().min(1).max(1024).optional(),
    }),
  }),
  /** Client-supplied replay identity (HTTP `Idempotency-Key` header / MCP tool argument). Trimmed before
   *  validation + hashing so MCP normalizes whitespace exactly as the HTTP header path does (a
   *  whitespace-only key trims to empty and fails `min(1)`) — the same logical key replays identically. */
  idempotencyKey: z.string().trim().min(1).max(BOOTSTRAP_IDEMPOTENCY_KEY_MAX),
});
export type BootstrapCommand = z.infer<typeof BootstrapCommandSchema>;

/**
 * A bounded, authority-FREE pointer from a successful bootstrap to the SEPARATELY authorized follow-on
 * workflows (DIN-1350 item 6). Bootstrap admits identity + intent only; it neither captures a credential
 * nor triggers a scan. Instead it returns this NextAction naming the immediate next steps and the Target
 * they concern — credential/HAR custody (DIN-1256) and Discovery — each stamped `authorized: false` to
 * state plainly that the caller must obtain separate authorization to proceed. It grants NO authority and
 * is derived identically on HTTP and MCP so the two surfaces agree on "what to do next".
 */
export const NextActionSchema = z.object({
  credentialSetup: z.object({
    workflow: z.literal('credential-har'),
    targetId: z.string().min(1),
    authorized: z.literal(false),
  }),
  discovery: z.object({
    workflow: z.literal('discovery'),
    targetId: z.string().min(1),
    authorized: z.literal(false),
  }),
});
export type NextAction = z.infer<typeof NextActionSchema>;

/**
 * Derive the bounded NextAction from an admitted outcome — pure and shared by both adapters, so HTTP and
 * MCP return byte-identical NextAction meaning. It reads only the admitted Target identity; it admits no
 * credential and triggers no scan (the follow-on workflows are separately authorized).
 */
export function deriveNextAction(outcome: AdmittedOutcome): NextAction {
  const targetId = outcome.artifacts.target.id;
  return {
    credentialSetup: { workflow: 'credential-har', targetId, authorized: false },
    discovery: { workflow: 'discovery', targetId, authorized: false },
  };
}

/**
 * The locked semantic status of a bootstrap admission — distinct from the transport status code and from
 * any "did this invocation replay" flag: `created` = this request minted a new admitted estate; `replayed`
 * = the canonical estate already existed and was returned by idempotent replay (or race-convergence). Both
 * surfaces project the same value for the same request.
 */
export type BootstrapStatus = 'created' | 'replayed';

/**
 * The transport-NEUTRAL bootstrap result projection (DIN-1350). The SINGLE place the admitted outcome is
 * projected onto the wire — the HTTP adapter and the MCP Tool BOTH return this exact shape, so identity,
 * semantic status, replay identity, and NextAction cannot diverge between surfaces. It exposes:
 *  - the admitted artifacts,
 *  - `requestId` — the canonical, immutable Bootstrap Request identity (the replay identity: an HTTP
 *    admission and a later MCP replay of the same key return the SAME value),
 *  - `status` — the locked semantic status ({@link BootstrapStatus}), NOT the transport status code,
 *  - `nextAction` — the bounded, authority-free next steps.
 */
export type BootstrapResult = {
  api: AdmittedArtifacts['api'];
  environment: AdmittedArtifacts['environment'];
  target: AdmittedArtifacts['target'];
  targetDefinition: AdmittedArtifacts['targetDefinition'];
  requestId: string;
  status: BootstrapStatus;
  nextAction: NextAction;
};

/** Project an admitted outcome onto the shared bootstrap result. `replayed` distinguishes a fresh admit
 *  (`created`) from an idempotent replay / race-convergence (`replayed`). */
export function projectBootstrapResult(
  outcome: AdmittedOutcome,
  opts: { replayed: boolean },
): BootstrapResult {
  return {
    api: outcome.artifacts.api,
    environment: outcome.artifacts.environment,
    target: outcome.artifacts.target,
    targetDefinition: outcome.artifacts.targetDefinition,
    requestId: outcome.requestId,
    status: opts.replayed ? 'replayed' : 'created',
    nextAction: deriveNextAction(outcome),
  };
}
