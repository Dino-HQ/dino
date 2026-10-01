// @dino/core — Barrel exports
export type { PlanUnit, PlanUnitId, PlanUnitControl, PlanUnitResult, Disposition, HttpMethod } from './types/workload-plan';
export { planUnitId } from './plan-unit-id';
export { ExecutorHttpError, ExecutorBlockedError, TransportDeadlineExceededError } from './executor-errors';

// Config defaults and resolution (#560)
export { DEFAULT_SCAN_CONFIG } from './config/defaults';
export type { ScanDefaults, ResolvedScanConfig } from './config/defaults';
export { resolveConfig, ConfigValidationError } from './config/resolve';
export type { UserConfigInput } from './config/resolve';

// Tenant config types
export type {
  TenantConfig,
  ApiConfig,
  GraphQLApiConfig,
  RestApiConfig,
  EnvironmentConfig,
  AuthConfig,
  TargetAuthConfig,
  RoleConfig,
  TokenRefreshConfig,
  AgentActivation,
  AgentSchedule,
} from './tenant/tenant-config';
export {
  toTargetAuthConfig,
  UNSUPPORTED_PROTOCOL_MESSAGE,
  UNSUPPORTED_PROTOCOLS,
  unsupportedProtocolMessage,
} from './tenant/tenant-config';

// Tenant loader
export {
  loadTenantConfig,
  validateTenantConfig,
  loadTenantById,
  resolveTenantConfigDir,
  resolveAndValidateDNS,
} from './tenant/tenant-loader';
export { TenantConfigError, isTenantConfigError, tenantConfigCode } from './tenant/tenant-config-error';
export type { TenantConfigErrorKind } from './tenant/tenant-config-error';
export type { DNSValidationResult } from './tenant/tenant-loader';
// #1850 — Node-only SSRF-pinning fetch (runner/CLI path). MUST NOT be imported by the Workers cloud bundle
// (it pulls node:https; the Worker cannot pin anyway — see docs/security/ssrf-dns-rebinding.md). Tree-shaken
// out of the worker because the cloud never imports it; enforced by scripts/check-workers-bundle-clean.mjs.
export {
  createPinnedFetch,
  createNodePinnedRequest,
  SsrfBlockedError,
} from './tenant/pinned-fetch';
export type { PinnedFetchDeps, PinnedRequestImpl, PinnedRequestArgs } from './tenant/pinned-fetch';

// AgentContext
export type { AgentContext, CreateAgentContextOptions } from './tenant/context';
export { createAgentContext } from './tenant/context';

// Domain verification — scan-target ownership classifier (#57, #2058)
export {
  hostFromUrl,
  classifyScanTargetHost,
  isHostVerified,
  classifyScanTargetGate,
  isEnvironmentScannable,
} from './tenant/domain-verification.js';
export type { ScanHostClass, ScanTargetGate } from './tenant/domain-verification.js';

// Operation types
export type {
  Operation,
  OperationAuth,
  OperationParameter,
  OperationRequestBody,
  OperationResponseSchema,
} from './types/operation';

// Introspection types (shared with @dino/agents)
export type { GraphQLOperation, InputTypeField } from './types/introspection';

// DCG v1.0 schema (#1094)
export {
  DcgV1Schema,
  DCG_V1_MINIMAL_EXAMPLE,
  parseDcgV1,
  AuthRequirementSchema,
  DcgConfidenceContractSchema,
  assertDcgConfidence,
} from './types/dcg';
export type { DcgV1 } from './types/dcg';

// DinoResult v1 — the one canonical engine result (Cleanup V2 task 2)
export {
  DinoResultV1Schema,
  DINO_RESULT_V1_MINIMAL_EXAMPLE,
  parseDinoResultV1,
  DinoResultSizeError,
  assertDinoResultPartitions,
  DinoResultPartitionError,
  findingKey,
  tupleKey,
  computeHealthScore,
  deriveExecutionCoverage,
  emitsCleanEntries,
  executionCoverageFor,
  healthVerdict,
  mergeSeverityLevels,
  runHealth,
  runTargetUnreachable,
  toolAppliesTo,
  toolProtocol,
  verdictDegraded,
  verdictEmptyRun,
  verdictIncomplete,
  verdictReasons,
  verificationCompleteness,
  byCodeUnit,
  canonicalDinoResultBytes,
  MAX_CANONICAL_BYTES,
  dinoResultDigest,
  CanonicalDomainError,
  sanitizeEvidenceText,
  sanitizeTargetUrl,
  assertNoSecretShape,
  DinoResultSecretError,
  SECRET_PATTERNS,
  EVIDENCE_MAX_CHARS,
  freezeDeep,
  DINO_TOOL_NAMES,
  DINO_SEVERITY_LEVELS,
  DINO_ENVELOPE_LEVELS,
  VERDICT_REASONS,
  TRIM_STEPS,
  ENUMERATION_GAP_REASONS,
  SCOPE_GAP_REASONS,
  Sha256Hex,
  buildFindingFingerprint,
  canonicalEvidenceKey, canonicalTargetKey, dinoFindingFingerprint,
  scopeDrift,
  operationSignature,
  partitionTools,
  toolCompleted,
  toolFailed,
} from './types/dino-result';
export type { DinoResult, DinoResultV1, DeepReadonly, DinoToolName, VerdictReason, TrimStep, ScopeGapReason, FindingFingerprintInput, ScopeDrift, OperationIdentity, ChangedOperation, VerificationToolRecord } from './types/dino-result';

// Exit-code contract (#2173), shared with @dino/cli and the engine (Cleanup V2 task 2)
export { EXIT_CODE, OUTCOME_PRECEDENCE, winningKind, resolveExitCode } from './exit-codes';
export type { OutcomeKind, ExitOutcome } from './exit-codes';

// Canonical REST operation keys (#1277) + the unified RBAC expectation key (#1860)
export {
  canonicalOperationKey,
  operationExpectationKey,
  restFindingKey,
} from './canonical-operation-key';

// Result envelope types (Phase 2 — AI Reasoning Layer)
export type {
  SeverityLevel,
  EnvelopeSeverityLevel,
  ResultEnvelope,
  EnvelopeSummary,
  NotTestedReason,
  NotTestedByReason,
  VerificationUnit,
  SeverityScore,
  SeverityFinding,
} from './types/result-envelope';
export { VERIFICATION_UNITS, NOT_TESTED_REASONS } from './types/result-envelope';

// Exhaustive switch guard (compile-time union coverage)
export { assertNever } from './utils/assert-never';

// Typed error hierarchy (Hypothesis-inspired, Stripe-patterned)
export type {
  DinoErrorCode,
  DinoErrorOptions,
  ValidationErrorCode,
  AuthErrorCode,
  NotFoundErrorCode,
  ConflictErrorCode,
  UpstreamErrorCode,
  ErrorMeta,
  ErrorClass,
  DispatchAmbiguousReason,
} from './errors';
export { ERROR_CONTRACT, errorContractFor } from './error-contract';
export * from './credential-unavailable';
export {
  errorBodyExtraFields,
  VALIDATION_ERROR_CODES,
  AUTH_ERROR_CODES,
  NOT_FOUND_ERROR_CODES,
  CONFLICT_ERROR_CODES,
  UPSTREAM_ERROR_CODES,
} from './errors';
export type { ErrorContractEntry, ErrorCliKind } from './error-contract';
export {
  DinoError,
  DinoValidationError,
  DinoAuthError,
  DinoNotFoundError,
  DinoConflictError,
  DinoUpstreamError,
  errorClassToCode,
} from './errors';
export type {
  CredentialNextAction,
  CredentialNextActionKind,
  CredentialReasonCode,
} from './credential-next-action';
export {
  CREDENTIAL_NEXT_ACTION_KINDS,
  CREDENTIAL_REASON_CODES,
  parseCredentialNextAction,
} from './credential-next-action';
export type { CredentialOutcomeCode } from './credential-outcome';
export { credentialOutcomeError, isCredentialOutcomeCode } from './credential-outcome';
export * from './target-connection-outcome';
export * from './auth-flow-outcome';
export * from './credential-handoff-outcome';
export type {
  TargetConnectionConfiguration,
  TargetConnectionFlowPin,
  TargetConnectionExecutionPlane,
  TargetConnectionLifecycleAction,
  TargetConnectionPrivateScope,
  TargetConnectionProposal,
  TargetConnectionPurpose,
  TargetConnectionRedirectPolicy,
  TargetConnectionRequestLimits,
  TargetConnectionStatus,
  TargetConnectionListView, TargetConnectionProposeCommand, TargetConnectionVersionView,
} from './types/target-connection';
export {
  TARGET_CONNECTION_CONTRACT_VERSION,
  TARGET_CONNECTION_EXECUTION_PLANES,
  TARGET_CONNECTION_LIFECYCLE_ACTIONS,
  TARGET_CONNECTION_LIMIT_CEILINGS,
  TARGET_CONNECTION_MAX_AUTH_PROFILES, TARGET_CONNECTION_MAX_FORWARDING_HOSTS, TARGET_CONNECTION_MAX_PORTS,
  TARGET_CONNECTION_PRIVATE_SCOPES,
  TARGET_CONNECTION_PURPOSES,
  TARGET_CONNECTION_REDIRECT_POLICIES,
  TARGET_CONNECTION_STATUSES,
  TARGET_CONNECTION_TRANSITIONS,
  TargetConnectionListRefSchema, TargetConnectionProposalSchema,
  TargetConnectionProposeCommandSchema, TargetConnectionVersionRefSchema,
  canTransitionTargetConnection,
} from './types/target-connection';

export * from './types/authentication-flow';
export * from './types/scan-authentication';

// Safe path validation (path traversal prevention)
export { safePath } from './utils/safe-path';

// Safe record utilities (detect-object-injection compliance)
export { recordGet, recordSet } from './utils/safe-record';

// Safe filesystem wrappers (detect-non-literal-fs-filename compliance)
export {
  safeExistsSync,
  safeReadFileSync,
  safeReadFileSyncContained,
  safeReaddirSync,
  safeMkdirSync,
  safeWriteFileSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  safeRename,
  safeReaddir,
} from './utils/safe-fs';

// Error message sanitizer (canonical; re-exported by @dino/agents)
export { sanitizeErrorMessage } from './utils/error-sanitizer';

// Branded ID types (platform safety — compile-time wrong-ID prevention)
export type {
  TenantId,
  RunnerId,
  ScanId,
  PresentationRequestId,
  CheckpointId,
  CheckpointVersionId,
  HumanActionRequestId,
} from './types/ids';
export {
  asTenantId,
  asRunnerId,
  asScanId,
  parsePresentationRequestId,
  parseCheckpointId,
  parseCheckpointVersionId,
  parseHumanActionRequestId,
} from './types/ids';

// Presentation Request, Checkpoint and Human Action Request (DIN-1354)
export {
  PRESENTATION_REQUEST_STATUSES,
  PRESENTATION_REQUEST_TRANSITIONS,
  PRESENTATION_CAPABILITIES,
  isPresentationRequestStatus,
  canTransitionPresentationRequest,
  isTerminalPresentationRequestStatus,
  derivePresentationNextAction,
} from './types/presentation-request';
export type {
  PresentationRequestStatus,
  PresentationCapability,
  CanonicalArtifactReference,
  CheckpointSnapshot,
  PresentationRequestView,
} from './types/presentation-request';
export {
  HUMAN_ACTION_REQUEST_STATUSES,
  HUMAN_CONTRIBUTION_KINDS,
  HAR_ACTION_TYPES,
  HAR_ACTION_CONTRIBUTION,
  HAR_REGISTRY,
  PRESENTATION_STEP_IDS,
  PRESENTATION_REASON_CODES,
  CREDENTIAL_REFERENCE_ID_PATTERN,
  canTransitionHumanActionRequest,
  harRegistryEntry,
  buildHumanHandoffContract,
  parsePresentationNextAction,
  PresentationRequestRefSchema,
  HumanActionRequestRefSchema,
  HarSubmissionCommandSchema,
  PresentationReopenCommandSchema,
  INVOKABLE_CAPABILITIES,
  canonicalCapabilityValue,
  capabilityArgumentsDigest,
  verifyReopenArguments,
  reopenAction,
} from './types/human-action-request';
export type {
  HumanActionRequestStatus,
  HumanContributionKind,
  HarActionType,
  HarRegistryEntry,
  HarRegistryEntryId,
  HarResumeTarget,
  HumanHandoffContract,
  HarAcceptedResponse,
  HumanActionRequestView,
  PresentationNextAction,
  PresentationReasonCode,
  PresentationStepId,
  HarSubmissionCommand,
  InvokableCapabilityId,
  ValidatedCapabilityArguments,
} from './types/human-action-request';

// Runner–cloud contract types (shared between CLI runner and cloud backend)
export type { RunnerJob, RunnerResult, ScanAttestationWire } from './types/runner';

// Scan lifecycle state machine (discriminated union for state-dependent field access)
export type { ScanStatus, ScanState } from './types/scan-status';
export { SCAN_STATUSES } from './types/scan-status';

// Scan budget / cloud-wait timing contract (F5) — shared by engine budget + cloud runner-wait
export {
  CLOUD_RUNNER_WAIT_MS,
  RESULT_UPLOAD_MARGIN_MS,
  MAX_ENGINE_SCAN_BUDGET_MS,
} from './scan/budget-contract';

// Runner lifecycle status types
export type { RunnerStatus, ManagedRunnerCloudStatus } from './types/runner-status';
export { RUNNER_STATUSES, MANAGED_RUNNER_CLOUD_STATUSES } from './types/runner-status';

// Audit event domain types (product contract, not persistence model)
export type { AuditAction, AuditActorType, AuditResourceType, AuditEvent } from './types/audit';

// Bootstrap Request + Admitted Outcome (P1A / DIN-1348; extended by P1B / DIN-1349)
export {
  BOOTSTRAP_CONTRACT_VERSION,
  BOOTSTRAP_ACTION,
  ENVIRONMENT_CLASSIFICATIONS,
  EnvironmentClassificationSchema,
  BootstrapProvenanceSchema,
  AdmittedApiSchema,
  AdmittedEnvironmentSchema,
  AdmittedTargetSchema,
  AdmittedTargetDefinitionSchema,
  TargetDefinitionScopeSchema,
  AdmittedArtifactsSchema,
  AdmittedOutcomeSchema,
  BOOTSTRAP_IDEMPOTENCY_KEY_MAX,
  BootstrapCommandSchema,
  normalizeBootstrapSemantics,
  normalizeTargetScope,
  projectBootstrapResult,
} from './types/bootstrap';
export type {
  BootstrapAction,
  EnvironmentClassification,
  BootstrapProvenance,
  AdmittedArtifacts,
  AdmittedOutcome,
  BootstrapCommand,
  BootstrapResult,
  BootstrapStatus,
  BootstrapSemanticsInput,
  TargetDefinitionScope,
} from './types/bootstrap';

// Member RBAC (#1276)
export {
  MEMBER_ROLES,
  ROLE_HIERARCHY,
  ROLE_LABELS,
  ROLE_ASSIGNABLE,
  MEMBER_ROLE_CATALOG,
  DINO_PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  meetsMinimumRole,
  effectivePermissionsForRole,
} from './types/member';
export type { MemberRole, DinoPermission, MemberRoleCatalogEntry } from './types/member';

export { PRINCIPAL_TYPES, AUTH_METHODS } from './types/access';
export type {
  PrincipalType,
  AuthMethod,
  AuthProvenance,
  AccessGrant,
  DelegationContext,
} from './types/access';

// TenantContextSnapshot (Phase 2 R1)
export { buildSnapshot } from './types/tenant-context-snapshot';
export type {
  TenantContextSnapshot,
  SchemaChange,
  HistoricalFinding,
  TenantRule,
  BuildSnapshotOptions,
} from './types/tenant-context-snapshot';

// Entitlement types (#1365)
export { TIER_NAMES, FEATURE_KEYS, GATE_TYPES } from './types/entitlement';
export type { TierName, FeatureKey, GateType, EntitlementResult } from './types/entitlement';

// SSRF guard used by @dino/auth flow-runner (exported so auth can import from the @dino/core barrel).
export {
  checkEndpointUrl,
  isBlockedIPv4,
  isLoopbackHostname,
  parseIPv4Octets,
  STRICT_DESTINATION,
} from './tenant/endpoint-validator';
export { isBlockedIPv6 } from './tenant/endpoint-validator-ipv6';
export type { EndpointPolicyOptions } from './tenant/endpoint-validator';
export { observeTransport, createObservedNativeFetch, mergeTransportStates } from './tenant/transport-observation';
export type { TransportState, TransportObservation, TransportControl, ObservedRequestInit } from './tenant/transport-observation';
export { VerificationTargetSchema, TenantEndpointSchema, resolveVerificationTarget } from './tenant/verification-target';
export { normalizeVerificationTarget } from './tenant/verification-target';
export type { VerificationTargetConfig, VerificationTarget, VerificationTargets } from './tenant/verification-target';
export type { WithheldBaseline, RestBaselineSetup } from './types/workload-setup';

// SARIF 2.1.0 projection of a DinoResult for GitHub code scanning (#2177)
export { renderDinoResultSarif, sarifCategory, sarifUnverifiedReason, sarifWithheldReason, type RenderSarifOptions, type SarifLog, type SarifResult, type SarifRule, type SarifRun, isStatefulRunSegment, parseSarifState, SARIF_STATE_VERSION, sarifRunToken, sarifUnitLabel, sarifUnitOf, splitAutomationId, type ParsedSarifState, type SarifState, type SarifStateEntry, type SarifUnit, SARIF_RULE_TEXT, type SarifRuleText, SECURITY_CLASSIFICATIONS, isSecurityClassification, reconcileSarif, type ReconcileSarifOptions, type ReconcileSarifOutcome, type SarifPrevious, type SarifPreviousAnalysis, type SarifPreviousState } from './sarif';
