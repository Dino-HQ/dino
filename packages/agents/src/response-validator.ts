/**
 * Project Dino — Response Schema Validator (package)
 *
 * Validates API responses against GraphQL types using Zod schemas.
 * Registry, executor, and typeResolver are passed via options (host provides).
 *
 * @see Issue #8, #135
 */

import type { ZodError, ZodType } from 'zod';
import { recordGet } from '@dino/core';
import { sanitizeErrorMessage } from './_error-sanitizer';
import { parseRegistry } from './test-scaffolder';
import {
  type TypeMap,
  type GQLTypeRef,
  MAX_DEPTH,
  generateZodSchema,
  buildFieldSelection,
} from './schema-generator';
import { guessOperationArgs, generateStubValue } from './query-builder';
import type { AgentClock } from './shared/agent-clock';
import { resolveClock, startTimer } from './shared/agent-clock';

export type ValidationClass =
  | 'VALID'
  | 'SCHEMA_MISMATCH'
  | 'EXTRA_FIELDS'
  | 'EXECUTION_ERROR'
  | 'INTROSPECTION_FAILURE';

export interface ValidationEntry {
  operation: string;
  module: string;
  returnType: string;
  classification: ValidationClass;
  errors: string[];
  durationMs: number;
}

export interface ValidationResult {
  timestamp: string;
  environment: string;
  dryRun: boolean;
  entries: ValidationEntry[];
  summary: {
    totalQueries: number;
    valid: number;
    schemaMismatches: number;
    extraFields: number;
    executionErrors: number;
    introspectionFailures: number;
  };
}

export type GraphQLExecutor = (
  document: string,
  variables?: Record<string, unknown>,
  options?: { authToken?: string },
) => Promise<{ data: unknown; errors: Array<{ message: string }> | null; status: number | null }>;

export interface ValidatorOptions {
  /** Operation registry (required; host passes OPERATION_REGISTRY or test registry). */
  registry: Record<string, string[]>;
  /** Only validate operations in these modules. Empty = all. */
  modules?: string[];
  dryRun?: boolean;
  operation?: string;
  executor?: GraphQLExecutor;
  typeResolver?: () => Promise<TypeMap>;
  authToken?: string;
  envName?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error?: (msg: string) => void;
  };
  clock?: AgentClock;
}

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} };

function unwrapReturnTypeName(ref: GQLTypeRef | null, depth = 0): string | null {
  if (!ref) return null;
  if (depth >= MAX_DEPTH) return null;
  if (ref.name) return ref.name;
  if (ref.ofType) return unwrapReturnTypeName(ref.ofType, depth + 1);
  return null;
}

function classifyZodResult(zodError: ZodError | null): ValidationClass {
  if (!zodError) return 'VALID';
  const allExtraFields = zodError.issues.every((issue) => issue.code === 'unrecognized_keys');
  if (allExtraFields) return 'EXTRA_FIELDS';
  return 'SCHEMA_MISMATCH';
}

function formatZodErrors(zodError: ZodError): string[] {
  return zodError.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message} (${issue.code})`;
  });
}

function buildDryRunEntry(opName: string, module: string, returnType: string): ValidationEntry {
  return {
    operation: opName,
    module,
    returnType,
    classification: 'VALID',
    errors: [],
    durationMs: 0,
  };
}

interface ValidateOperationOptions {
  opName: string;
  module: string;
  returnType: string;
  typeMap: TypeMap;
  exec: GraphQLExecutor;
  authToken: string;
  schemaCache: Map<string, ZodType>;
  clock: AgentClock;
}

async function validateOperation(opts: ValidateOperationOptions): Promise<ValidationEntry> {
  const { opName, module, returnType, typeMap, exec, authToken, schemaCache, clock } = opts;
  const gqlType = typeMap.get(returnType);
  if (!gqlType) {
    return {
      operation: opName,
      module,
      returnType,
      classification: 'INTROSPECTION_FAILURE',
      errors: [`Type "${returnType}" not found in type map`],
      durationMs: 0,
    };
  }

  const fieldSelection = buildFieldSelection(returnType, typeMap);
  const zodSchema = generateZodSchema(returnType, typeMap, 0, schemaCache);

  const args = guessOperationArgs(opName);
  let query: string;
  let variables: Record<string, unknown> | undefined;
  if (args.length > 0) {
    const varDecls = args.map((a) => `$${a.name}: ${a.type}`).join(', ');
    const argPasses = args.map((a) => `${a.name}: $${a.name}`).join(', ');
    const sel = fieldSelection ? ` ${fieldSelection}` : '';
    const capitalName = opName[0].toUpperCase() + opName.slice(1);
    query = `query ${capitalName}(${varDecls}) { ${opName}(${argPasses})${sel} }`;
    variables = Object.fromEntries(args.map((a) => [a.name, generateStubValue(a.type)]));
  } else {
    query = fieldSelection ? `query { ${opName} ${fieldSelection} }` : `query { ${opName} }`;
    variables = undefined;
  }

  const elapsed = startTimer(clock);
  const response = await exec(query, variables ?? undefined, { authToken });
  const durationMs = elapsed();

  if (!response) {
    return {
      operation: opName,
      module,
      returnType,
      classification: 'EXECUTION_ERROR',
      errors: ['Executor returned null or undefined response'],
      durationMs,
    };
  }

  if (response.errors && response.errors.length > 0) {
    return {
      operation: opName,
      module,
      returnType,
      classification: 'EXECUTION_ERROR',
      errors: response.errors.map((e) => e.message),
      durationMs,
    };
  }

  return validateResponseData(opName, module, returnType, response.data, zodSchema, durationMs);
}

function validateResponseData(
  opName: string,
  module: string,
  returnType: string,
  data: unknown,
  zodSchema: ZodType,
  durationMs: number,
): ValidationEntry {
  // Bug #403: Defensive check for non-standard data shapes
  if (!data || typeof data !== 'object') {
    return {
      operation: opName,
      module,
      returnType,
      classification: 'EXECUTION_ERROR',
      errors: [`Response data is not an object: ${typeof data}`],
      durationMs,
    };
  }

  const opData = recordGet(data as Record<string, unknown>, opName);
  const parseResult = zodSchema.safeParse(opData);

  if (parseResult.success) {
    return {
      operation: opName,
      module,
      returnType,
      classification: 'VALID',
      errors: [],
      durationMs,
    };
  }

  const classification = classifyZodResult(parseResult.error);
  const errors = formatZodErrors(parseResult.error);
  return { operation: opName, module, returnType, classification, errors, durationMs };
}

/** @internal Exported for invariant testing only. */
export function updateSummary(summary: ValidationResult['summary'], entry: ValidationEntry): void {
  summary.totalQueries++;
  switch (entry.classification) {
    case 'VALID':
      summary.valid++;
      break;
    case 'SCHEMA_MISMATCH':
      summary.schemaMismatches++;
      break;
    case 'EXTRA_FIELDS':
      summary.extraFields++;
      break;
    case 'EXECUTION_ERROR':
      summary.executionErrors++;
      break;
    case 'INTROSPECTION_FAILURE':
      summary.introspectionFailures++;
      break;
  }
}

function resolveReturnType(opName: string, typeMap: TypeMap): string | null {
  const queryType = typeMap.get('Query');
  if (!queryType?.fields) return null;
  const field = queryType.fields.find((f) => f.name === opName);
  if (!field) return null;
  return unwrapReturnTypeName(field.type);
}

interface ProcessValidationOptions {
  op: ReturnType<typeof parseRegistry>[number];
  returnType: string;
  dryRun: boolean;
  typeMap: TypeMap;
  executor: GraphQLExecutor;
  authToken: string;
  schemaCache: Map<string, ZodType>;
  clock: AgentClock;
}

async function processValidation(opts: ProcessValidationOptions): Promise<ValidationEntry> {
  const { op, returnType, dryRun, typeMap, executor, authToken, schemaCache, clock } = opts;
  if (dryRun) {
    return buildDryRunEntry(op.name, op.module, returnType);
  }

  return validateOperation({
    opName: op.name,
    module: op.module,
    returnType,
    typeMap,
    exec: executor,
    authToken,
    schemaCache,
    clock,
  });
}

function validateOptions(options: ValidatorOptions): void {
  if (!options.dryRun) {
    if (!options.executor) throw new Error('executor is required when not in dryRun mode');
    if (!options.typeResolver) throw new Error('typeResolver is required when not in dryRun mode');
  }
}

async function resolveTypeMap(
  resolveTypes: () => Promise<TypeMap>,
  result: ValidationResult,
  log: { info: (msg: string) => void; warn: (msg: string) => void; error?: (msg: string) => void },
): Promise<TypeMap | null> {
  try {
    return await resolveTypes();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const safe = sanitizeErrorMessage(message);
    if (log.error) log.error(`[ResponseValidator] Failed to introspect types: ${safe}`);
    // B90 (#659): Use __dino_synthetic__ prefix so downstream (catalog, reports)
    // can filter this out. '__introspection__' looked like a real operation.
    result.entries.push({
      operation: '__dino_synthetic__introspection_failure',
      module: '__system__',
      returnType: 'N/A',
      classification: 'INTROSPECTION_FAILURE',
      errors: [`Introspection failed: ${safe}`],
      durationMs: 0,
    });
    result.summary.totalQueries = 0;
    result.summary.introspectionFailures = 1;
    return null;
  }
}

export async function runResponseValidator(options: ValidatorOptions): Promise<ValidationResult> {
  const dryRun = options.dryRun ?? false;
  validateOptions(options);
  const executor = options.executor as GraphQLExecutor;
  const resolveTypes = options.typeResolver as () => Promise<TypeMap>;
  const registry = options.registry;
  const authToken = options.authToken ?? '';
  const envName = options.envName ?? 'unknown';
  const log = options.logger ?? NOOP_LOG;
  const clock = resolveClock(options.clock);

  const result: ValidationResult = {
    timestamp: clock.isoNow(),
    environment: envName,
    dryRun,
    entries: [],
    summary: {
      totalQueries: 0,
      valid: 0,
      schemaMismatches: 0,
      extraFields: 0,
      executionErrors: 0,
      introspectionFailures: 0,
    },
  };

  const typeMap = await resolveTypeMap(resolveTypes, result, log);
  if (!typeMap) return result;

  const moduleFilter =
    options.modules && options.modules.length > 0 ? new Set(options.modules) : null;
  let operations = parseRegistry(registry)
    .filter((op) => op.type === 'query')
    .filter((op) => !moduleFilter || moduleFilter.has(op.module));

  if (options.operation) {
    operations = operations.filter((op) => op.name === options.operation);
  }

  log.info(`[ResponseValidator] ${operations.length} queries to validate`);

  if (operations.length === 0) {
    log.info('[ResponseValidator] No queries found. Nothing to validate.');
    return result;
  }

  const schemaCache = new Map<string, ZodType>();

  for (const op of operations) {
    const returnType = resolveReturnType(op.name, typeMap);
    if (returnType == null) {
      log.warn(
        `[ResponseValidator] resolveReturnType returned null for "${op.name}" — using sentinel`,
      );
    }
    const effectiveReturnType = returnType ?? '[UNRESOLVED_TYPE]';
    const entry = await processValidation({
      op,
      returnType: effectiveReturnType,
      dryRun,
      typeMap,
      executor,
      authToken,
      schemaCache,
      clock,
    });
    result.entries.push(entry);
    updateSummary(result.summary, entry);
  }

  const { summary } = result;
  log.info(
    `[ResponseValidator] Complete: ${summary.totalQueries} queries ` +
      `(${summary.valid} valid, ${summary.schemaMismatches} mismatches, ${summary.extraFields} extra fields, ` +
      `${summary.executionErrors} execution errors, ${summary.introspectionFailures} introspection failures` +
      `${result.dryRun ? ', DRY RUN' : ''})`,
  );

  return result;
}
