// @dino/core — Barrel exports

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
  GrpcApiConfig,
  EnvironmentConfig,
  AuthConfig,
  TargetAuthConfig,
  RoleConfig,
  TokenRefreshConfig,
  AgentActivation,
  AgentSchedule,
} from './tenant/tenant-config';
export { toTargetAuthConfig } from './tenant/tenant-config';

// Tenant loader
export {
  loadTenantConfig,
  validateTenantConfig,
  loadTenantById,
  resolveAndValidateDNS,
} from './tenant/tenant-loader';
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

// Domain verification — scan-target ownership classifier (#57)
export {
  hostFromUrl,
  classifyScanTargetHost,
  isHostVerified,
} from './tenant/domain-verification.js';
export type { ScanHostClass } from './tenant/domain-verification.js';

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
} from './types/dcg';
export type { DcgV1 } from './types/dcg';

// Canonical REST operation keys (#1277) + the unified RBAC expectation key (#1860)
export { canonicalOperationKey, operationExpectationKey } from './canonical-operation-key';

// Result envelope types (Phase 2 — AI Reasoning Layer)
export type {
  SeverityLevel,
  EnvelopeSeverityLevel,
  ResultEnvelope,
  EnvelopeSummary,
  SeverityScore,
  SeverityFinding,
} from './types/result-envelope';

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
} from './errors';
export {
  DinoError,
  DinoValidationError,
  DinoAuthError,
  DinoNotFoundError,
  DinoConflictError,
  DinoUpstreamError,
  errorClassToCode,
} from './errors';

// Safe path validation (path traversal prevention)
export { safePath } from './utils/safe-path';

// Safe record utilities (detect-object-injection compliance)
export { recordGet, recordSet } from './utils/safe-record';

// Safe filesystem wrappers (detect-non-literal-fs-filename compliance)
export {
  safeExistsSync,
  safeReadFileSync,
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
export type { TenantId, RunnerId, ScanId } from './types/ids';
export { asTenantId, asRunnerId, asScanId } from './types/ids';

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

// Sentinel signals (#1259)
export {
  SENTINEL_LEVELS,
  SIGNAL_TRIGGER_CLASSES,
  SIGNAL_STATUSES,
  SIGNAL_SEVERITIES,
  SIGNAL_FEEDBACKS,
  FRONTEND_IMPACTS,
  SIGNAL_SOURCES,
  SIGNAL_CORRELATION_STATUSES,
} from './types/sentinel';
export type {
  SentinelLevel,
  SignalTriggerClass,
  SignalStatus,
  SignalSeverity,
  SignalFeedback,
  FrontendImpact,
  SignalSource,
  SignalCorrelationStatus,
  SentinelScanCommand,
} from './types/sentinel';

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
export { checkEndpointUrl } from './tenant/endpoint-validator';
