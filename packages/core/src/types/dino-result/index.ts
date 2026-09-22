export { DinoResultV1Schema, DINO_RESULT_V1_MINIMAL_EXAMPLE } from './v1';
export { DinoResultSizeError, parseDinoResultV1 } from './parse';
export { assertDinoResultPartitions, DinoResultPartitionError, findingKey, tupleKey } from './partitions';
export {
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
  type CoverageLedgerEntry,
  type CoverageStatus,
  type CoverageToolFindings,
  type ExecutionCoverage,
  type HealthVerdict,
} from './derived';
export { byCodeUnit, canonicalDinoResultBytes, MAX_CANONICAL_BYTES, dinoResultDigest, CanonicalDomainError } from './canonical';
export {
  sanitizeEvidenceText,
  sanitizeTargetUrl,
  assertNoSecretShape,
  DinoResultSecretError,
  SECRET_PATTERNS,
  EVIDENCE_MAX_CHARS,
} from './sanitize';
export { freezeDeep } from './freeze';
export { partitionTools, toolCompleted, toolFailed, type VerificationToolRecord } from './tool-partition';
export { buildFindingFingerprint, type FindingFingerprintInput } from './fingerprint';
export { scopeDrift, operationSignature, type ScopeDrift, type OperationIdentity, type ChangedOperation } from './drift';
export { DINO_TOOL_NAMES, DINO_SEVERITY_LEVELS, DINO_ENVELOPE_LEVELS, Sha256Hex } from './v1-common';
export { VERDICT_REASONS, TRIM_STEPS } from './v1-verdict';
export { ENUMERATION_GAP_REASONS, SCOPE_GAP_REASONS, type ScopeGapReason } from './v1-scope';
export type { DinoResult, DinoResultV1, DeepReadonly } from './v1';
export type { DinoToolName } from './v1-common';
export type { VerdictReason, TrimStep } from './v1-verdict';
