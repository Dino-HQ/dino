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
  RoleConfig,
  TokenRefreshConfig,
  AgentActivation,
  AgentSchedule,
} from './tenant/tenant-config';

// Tenant loader
export {
  loadTenantConfig,
  validateTenantConfig,
  loadTenantById,
  resolveAndValidateDNS,
} from './tenant/tenant-loader';
export type { DNSValidationResult } from './tenant/tenant-loader';

// AgentContext
export type { AgentContext, CreateAgentContextOptions } from './tenant/context';
export { createAgentContext } from './tenant/context';

// Operation types
export type { Operation, OperationAuth } from './types/operation';

// Introspection types (shared with @dino/agents)
export type { GraphQLOperation, InputTypeField } from './types/introspection';

// Result envelope types (Phase 2 — AI Reasoning Layer)
export type {
  SeverityLevel,
  EnvelopeSeverityLevel,
  ResultEnvelope,
  EnvelopeSummary,
  SeverityScore,
  SeverityFinding,
} from './types/result-envelope';

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

// TenantContextSnapshot (Phase 2 R1)
export { buildSnapshot } from './types/tenant-context-snapshot';
export type {
  TenantContextSnapshot,
  SchemaChange,
  HistoricalFinding,
  TenantRule,
  BuildSnapshotOptions,
} from './types/tenant-context-snapshot';
