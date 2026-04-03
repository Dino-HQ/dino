// @dino/agents — Domain-specific QA agents
// Barrel exports (expanded as agents are migrated).

export { sanitizeErrorMessage } from './_error-sanitizer';

export { generateFuzzInputs, QUICK_STRATEGIES, ALL_STRATEGIES } from './fuzz-strategies';
export type { FuzzStrategyName, FuzzInput, ArgInfo, FuzzStrategyOptions } from './fuzz-strategies';

export { getExpectation } from './rbac-expectations';
export type {
  ExpectedAccess,
  AuthState,
  RbacExpectation,
  ExpectationsMap,
  DefaultExpectationsMap,
} from './rbac-expectations';

export {
  generateStubValue,
  buildSmartMutation,
  resolveQueryArgs,
  guessOperationArgs,
} from './query-builder';
export type { SmartMutation, TypeMaps } from './query-builder';

export {
  parseRegistry,
  collectTestFiles,
  findExistingTest,
  toKebabCase,
  calculateImportDepth,
  generateTestContent,
  scaffoldTests,
} from './test-scaffolder';
export type {
  ScaffoldLogger,
  ScaffoldOptions,
  ScaffoldedFile,
  ScaffoldResult,
} from './test-scaffolder';

export {
  MAX_DEPTH,
  introspectFullTypes,
  generateZodSchema,
  buildFieldSelection,
} from './schema-generator';
export type {
  IntrospectTypesOptions,
  SchemaGeneratorLogger,
  GQLField,
  GQLTypeRef,
  GQLType,
  TypeMap,
} from './schema-generator';

export { runResponseValidator } from './response-validator';
export type {
  GraphQLExecutor,
  ValidatorOptions,
  ValidationResult,
  ValidationEntry,
  ValidationClass,
} from './response-validator';

export {
  detectDataLeak,
  classifyFuzzResponse,
  buildFuzzDocument,
  runInputFuzzer,
} from './input-fuzzer';
export type {
  FuzzExecutor,
  FuzzOptions,
  FuzzResult,
  FuzzEntry,
  FuzzResponseClass,
  FuzzMode,
} from './input-fuzzer';

export {
  extractMutations,
  extractOperations,
  buildMinimalMutation,
  classifyResponse,
  determineInterceptionLayer,
  detectSecurityIssue,
  evaluateResult,
  runRbacMatrix,
  DEFAULT_ROLES,
} from './rbac-matrix';
export type {
  ResponseClass,
  InterceptionLayer,
  RbacMatrixEntry,
  SecurityIssue,
  RbacMatrixResult,
  RbacMatrixOptions,
  GraphQLError as RbacGraphQLError,
  IntrospectionOperation,
  OperationInfo,
} from './rbac-matrix';

export {
  extractRateLimitHeaders,
  classifyRateLimitResponse,
  buildRateLimitOperation,
  runRateLimitValidator,
  computeConfidence,
  COMMON_RATE_LIMIT_FLOOR,
} from './rate-limit-validator';
export type {
  RateLimitClass,
  RateLimitHeader,
  BurstRequestResult,
  RateLimitEntry,
  RateLimitResult,
  RateLimitOptions,
} from './rate-limit-validator';

export {
  detectStackTrace,
  detectFilePath,
  detectInternalDetail,
  detectLeaks,
  buildErrorTestQuery,
  classifyErrorResponse,
  runErrorCodeValidator,
} from './error-code-validator';
export type {
  ErrorScenario,
  ConsistencyClass,
  ErrorCodeEntry,
  ErrorCodeResult,
  ErrorCodeOptions,
  LeakFlags,
} from './error-code-validator';

export { runDeprecationTracker } from './deprecation-tracker';
export type {
  DeprecationLevel,
  DeprecationEntry,
  DeprecationResult,
  DeprecatedTypeField,
  DeprecatedTypeInfo,
  DeprecationOptions,
  DeprecationOperationInfo,
} from './deprecation-tracker';
