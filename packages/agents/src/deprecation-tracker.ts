/**
 * Project Dino — Deprecation Lifecycle Tracker
 *
 * Agent tool that scans the live GraphQL schema for deprecated operations,
 * fields, input fields, and enum values. Cross-references against the
 * OPERATION_REGISTRY to flag deprecated items still in use.
 *
 * Design:
 * - 4 deprecation levels: OPERATION, FIELD, INPUT_FIELD, ENUM_VALUE
 * - Operation-level: reuses introspect() from introspect.ts
 * - Type-level: dedicated query with includeDeprecated: true (required by spec)
 * - Registry cross-reference via parseRegistry() (operations only)
 * - Module filter applies only to OPERATION level (registry has no type→module map)
 * - DI pattern for testability (operationResolver, typeResolver)
 *
 * @example Agent usage:
 *   const result = await runDeprecationTracker({ dryRun: true });
 *   // result.summary.inRegistry → deprecated ops still expected
 *
 * @see Issue #9 — Deprecation lifecycle tracker
 */

import { sanitizeErrorMessage } from './_error-sanitizer';
import { parseRegistry } from './test-scaffolder';
import type { AgentClock } from './shared/agent-clock';
import { resolveClock } from './shared/agent-clock';

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} };

/** Operation shape returned by operationResolver (host provides). */
export interface DeprecationOperationInfo {
  name: string;
  type: string;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeprecationLevel = 'OPERATION' | 'FIELD' | 'INPUT_FIELD' | 'ENUM_VALUE';

export interface DeprecationEntry {
  level: DeprecationLevel;
  name: string;
  parentType?: string;
  reason: string | null;
  module?: string;
  inRegistry: boolean;
  firstSeen: string;
  /** True if this item was not deprecated in the previous scan. */
  newlyDeprecated?: boolean;
}

export interface DeprecationResult {
  timestamp: string;
  environment: string;
  dryRun: boolean;
  /** True when introspection failed. */
  failed: boolean;
  /** Error message when failed. */
  failureReason?: string;
  entries: DeprecationEntry[];
  summary: {
    total: number;
    operations: number;
    fields: number;
    inputFields: number;
    enumValues: number;
    withReason: number;
    withoutReason: number;
    inRegistry: number;
    newlyDeprecated: number;
  };
}

export interface DeprecatedTypeField {
  name: string;
  isDeprecated: boolean;
  deprecationReason: string | null;
}

export interface DeprecatedTypeInfo {
  name: string;
  kind: string;
  fields: DeprecatedTypeField[] | null;
  inputFields: DeprecatedTypeField[] | null;
  enumValues: DeprecatedTypeField[] | null;
}

export interface DeprecationOptions {
  modules?: string[];
  dryRun?: boolean;
  level?: DeprecationLevel;
  /** Operation registry (required). */
  registry: Record<string, string[]>;
  /** Resolver for operations (name, type, isDeprecated, deprecationReason). Required when not dryRun. */
  operationResolver?: () => Promise<DeprecationOperationInfo[]>;
  /** Resolver for schema types with deprecated fields/enumValues. Required when not dryRun. */
  typeResolver?: () => Promise<DeprecatedTypeInfo[]>;
  /** Previous scan's deprecation entries for diff detection. */
  previousEntries?: DeprecationEntry[];
  envName?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error?: (msg: string) => void;
  };
  clock?: AgentClock;
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Build the operation→module lookup from the registry.
 */
function buildOperationModuleMap(registry: Record<string, string[]>): Map<string, string> {
  const map = new Map<string, string>();
  const parsed = parseRegistry(registry);
  for (const op of parsed) {
    map.set(op.name, op.module);
  }
  return map;
}

/**
 * Collect deprecated operations from introspection results.
 */
function collectOperationDeprecations(
  operations: DeprecationOperationInfo[],
  opModuleMap: Map<string, string>,
  timestamp: string,
): DeprecationEntry[] {
  const entries: DeprecationEntry[] = [];

  for (const op of operations) {
    if (!op.isDeprecated) continue;

    const module = opModuleMap.get(op.name);
    entries.push({
      level: 'OPERATION',
      name: op.name,
      reason: op.deprecationReason ?? null,
      module,
      inRegistry: opModuleMap.has(op.name),
      firstSeen: timestamp,
    });
  }

  return entries;
}

/**
 * Extract deprecated items from a single field list (fields, inputFields, or enumValues).
 */
function extractDeprecatedItems(
  items: DeprecatedTypeField[] | null,
  level: DeprecationLevel,
  typeName: string,
  timestamp: string,
): DeprecationEntry[] {
  if (!items) return [];
  const entries: DeprecationEntry[] = [];
  for (const item of items) {
    if (!item.isDeprecated) continue;
    entries.push({
      level,
      name: `${typeName}.${item.name}`,
      parentType: typeName,
      reason: item.deprecationReason,
      inRegistry: false,
      firstSeen: timestamp,
    });
  }
  return entries;
}

/**
 * Collect deprecated fields, input fields, and enum values from type info.
 */
function collectTypeDeprecations(
  types: DeprecatedTypeInfo[],
  timestamp: string,
): DeprecationEntry[] {
  const entries: DeprecationEntry[] = [];

  for (const type of types) {
    if (type.name.startsWith('__')) continue;
    entries.push(
      ...extractDeprecatedItems(type.fields, 'FIELD', type.name, timestamp),
      ...extractDeprecatedItems(type.inputFields, 'INPUT_FIELD', type.name, timestamp),
      ...extractDeprecatedItems(type.enumValues, 'ENUM_VALUE', type.name, timestamp),
    );
  }

  return entries;
}

/**
 * Apply level and module filters to the entry list.
 *
 * Module filter only applies to OPERATION level because the registry
 * maps operations to modules, not types or fields.
 */
function applyFilters(
  entries: DeprecationEntry[],
  options: DeprecationOptions,
  log: { info: (msg: string) => void },
): DeprecationEntry[] {
  let filtered = entries;

  if (options.level) {
    filtered = filtered.filter((e) => e.level === options.level);
  }

  if (options.modules && options.modules.length > 0) {
    log.info('Module filter active — showing OPERATION level only');
    const moduleSet = new Set(options.modules);
    filtered = filtered.filter(
      (e) => e.level === 'OPERATION' && e.module !== undefined && moduleSet.has(e.module),
    );
  }

  return filtered;
}

/**
 * Build summary counts from the entry list.
 * @internal Exported for invariant testing only.
 */
export function buildSummary(entries: DeprecationEntry[]): DeprecationResult['summary'] {
  let operations = 0;
  let fields = 0;
  let inputFields = 0;
  let enumValues = 0;
  let withReason = 0;
  let withoutReason = 0;
  let inRegistry = 0;
  let newlyDeprecated = 0;

  for (const entry of entries) {
    switch (entry.level) {
      case 'OPERATION':
        operations++;
        break;
      case 'FIELD':
        fields++;
        break;
      case 'INPUT_FIELD':
        inputFields++;
        break;
      case 'ENUM_VALUE':
        enumValues++;
        break;
    }

    if (entry.reason) {
      withReason++;
    } else {
      withoutReason++;
    }

    if (entry.inRegistry) {
      inRegistry++;
    }

    if (entry.newlyDeprecated) {
      newlyDeprecated++;
    }
  }

  return {
    total: entries.length,
    operations,
    fields,
    inputFields,
    enumValues,
    withReason,
    withoutReason,
    inRegistry,
    newlyDeprecated,
  };
}

/**
 * Log the deprecation scan summary.
 */
function logDeprecationSummary(
  result: DeprecationResult,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  const s = result.summary;
  log.info(
    `Deprecation scan: ${s.total} deprecated items found ` +
      `(${s.operations} ops, ${s.fields} fields, ${s.inputFields} input fields, ${s.enumValues} enums)`,
  );
  if (s.inRegistry > 0) {
    log.warn(`${s.inRegistry} deprecated operation(s) still in registry`);
  }
  if (s.withoutReason > 0) {
    log.warn(`${s.withoutReason} deprecated item(s) missing deprecation reason`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryKey(e: Pick<DeprecationEntry, 'level' | 'name'>): string {
  return `${e.level}:${e.name}`;
}

/** Compare entries against previousEntries to set newlyDeprecated flag. */
function markNewlyDeprecated(
  entries: DeprecationEntry[],
  previousEntries: DeprecationEntry[] | undefined,
): void {
  if (previousEntries === undefined) return;
  const previousKeys = previousEntries.length > 0 ? new Set(previousEntries.map(entryKey)) : null;
  for (const entry of entries) {
    entry.newlyDeprecated = previousKeys ? !previousKeys.has(entryKey(entry)) : true;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Scan the live GraphQL schema for deprecated operations, fields, input
 * fields, and enum values. Cross-references against the provided registry.
 */
export async function runDeprecationTracker(
  options: DeprecationOptions,
): Promise<DeprecationResult> {
  const registry = options.registry;
  const envName = options.envName ?? 'unknown';
  const log = options.logger ?? NOOP_LOG;
  const clock = resolveClock(options.clock);
  const timestamp = clock.isoNow();

  log.info(`Starting deprecation scan on ${envName} environment`);

  // 1. Dry run — return empty result
  if (options.dryRun) {
    log.info('Dry run — skipping introspection');
    return {
      timestamp,
      environment: envName,
      dryRun: true,
      failed: false,
      entries: [],
      summary: buildSummary([]),
    };
  }

  if (!options.operationResolver || !options.typeResolver) {
    throw new Error('operationResolver and typeResolver required when not in dry-run mode');
  }

  const resolveOperations = options.operationResolver;
  const resolveTypes = options.typeResolver;

  // 2. Build operation→module lookup
  const opModuleMap = buildOperationModuleMap(registry);

  // 3. Introspect operations and types in parallel
  let operations: DeprecationOperationInfo[];
  let types: DeprecatedTypeInfo[];
  try {
    [operations, types] = await Promise.all([resolveOperations(), resolveTypes()]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const safe = sanitizeErrorMessage(message);
    if (log.error) {
      log.error(`Introspection failed: ${safe}`);
    } else {
      log.warn(`Introspection failed: ${safe}`);
    }
    return {
      timestamp,
      environment: envName,
      dryRun: false,
      failed: true,
      failureReason: safe,
      entries: [],
      summary: buildSummary([]),
    };
  }

  // 4. Collect deprecations
  const opEntries = collectOperationDeprecations(operations, opModuleMap, timestamp);
  const typeEntries = collectTypeDeprecations(types, timestamp);
  const allEntries = [...opEntries, ...typeEntries];

  // 4b. Mark newlyDeprecated by comparing to previousEntries (composite key: level:name)
  markNewlyDeprecated(allEntries, options.previousEntries);

  // 5. Apply filters
  const filtered = applyFilters(allEntries, options, log);

  // 6. Build result
  const result: DeprecationResult = {
    timestamp,
    environment: envName,
    dryRun: false,
    failed: false,
    entries: filtered,
    summary: buildSummary(filtered),
  };

  // 7. Log summary
  logDeprecationSummary(result, log);

  return result;
}
