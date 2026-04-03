/**
 * Project Dino — Test Skeleton Scaffolder
 *
 * Agent tool that auto-generates contract test skeletons for GraphQL operations
 * that lack test coverage. Scans the operation registry (passed via options),
 * checks for existing tests by searching test file contents for the operation
 * name in GQL strings, and generates skeleton test files for untested operations.
 *
 * Design decisions (approved in Issue #5 plan):
 * - TypeScript template literals (zero new dependencies, no Handlebars)
 * - Existing test detection by scanning GQL query/mutation strings in test files
 * - Complex input types: generate $input variable with TODO comment
 * - Import paths calculated dynamically based on output directory depth
 * - Unauthenticated test uses explicit { authToken: '' }
 * - Early-return patterns (SOC 2 / Aikido compliance)
 * - No CLI in package; host provides runner script (Issue #135).
 *
 * @example Agent usage:
 *   const result = await scaffoldTests({ registry: OPERATION_REGISTRY });
 *   // result.created → list of files that were generated
 *   // result.skipped → operations that already have tests
 *   // result.errors → operations that failed to scaffold
 */

import * as path from 'node:path';
import {
  safeExistsSync,
  safeReadFileSync,
  safeReaddirSync,
  safeMkdirSync,
  safeWriteFileSync,
} from '@dino/core';
import type { AgentClock } from './shared/agent-clock';
import { resolveClock } from './shared/agent-clock';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OperationType = 'query' | 'mutation' | 'subscription';

/** Minimal logger interface (DI from host; noop default in package). */
export interface ScaffoldLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const NOOP_LOG: ScaffoldLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface ScaffoldOptions {
  /** Root directory of the project. Defaults to process.cwd(). */
  projectRoot?: string;
  /** Operation registry (module -> operation names). Required; pass from host (e.g. OPERATION_REGISTRY). */
  registry: Record<string, string[]>;
  /** Logger; defaults to noop. */
  logger?: ScaffoldLogger;
  /** Only scaffold operations in these modules. Empty = all modules. */
  modules?: string[];
  /** Only scaffold operations of these types. Empty = all types. */
  types?: Array<OperationType>;
  /** Dry run — don't write files, just report what would be created. */
  dryRun?: boolean;
  /** Override test output base directory (relative to projectRoot). Default: tests/contract */
  testDir?: string;
  clock?: AgentClock;
}

export interface ScaffoldedFile {
  operationName: string;
  operationType: OperationType;
  module: string;
  filePath: string;
}

export interface ScaffoldResult {
  timestamp: string;
  projectRoot: string;
  dryRun: boolean;
  created: ScaffoldedFile[];
  skipped: Array<{
    operationName: string;
    reason: string;
    existingFile: string;
  }>;
  errors: Array<{
    operationName: string;
    error: string;
  }>;
  summary: {
    totalOperations: number;
    created: number;
    skipped: number;
    errors: number;
  };
}

interface ParsedOperation {
  name: string;
  type: OperationType;
  module: string;
}

// ---------------------------------------------------------------------------
// Registry parsing
// ---------------------------------------------------------------------------

/**
 * Parse the registry into a flat list of operations with module info.
 */
export function parseRegistry(
  registry: Record<string, string[]>,
  logger?: { warn: (msg: string) => void },
): ParsedOperation[] {
  const operations: ParsedOperation[] = [];
  const validTypes = new Set(['query', 'mutation', 'subscription']);

  for (const [key, ops] of Object.entries(registry)) {
    const parts = key.split(':');
    if (parts.length !== 2 || !validTypes.has(parts[1])) {
      logger?.warn(`[parseRegistry] Skipping invalid key "${key}" — expected "module:type" format`);
      continue;
    }
    const [moduleSlug, type] = parts as [string, 'query' | 'mutation' | 'subscription'];

    if (!Array.isArray(ops)) {
      logger?.warn(`[parseRegistry] Skipping key "${key}" — value is not an array`);
      continue;
    }
    for (const name of ops) {
      operations.push({ name, type, module: moduleSlug });
    }
  }

  return operations;
}

// ---------------------------------------------------------------------------
// Existing test detection
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .test.ts and .spec.ts files under a directory.
 * Bounded to MAX_DEPTH levels to prevent unbounded recursion from symlink
 * cycles or deeply nested structures.
 */
const MAX_DEPTH = 10;

export function collectTestFiles(
  dir: string,
  depth: number = 0,
  log: ScaffoldLogger = NOOP_LOG,
): string[] {
  if (!safeExistsSync(dir, dir)) {
    return [];
  }
  if (depth >= MAX_DEPTH) {
    log.warn(`collectTestFiles: max depth (${MAX_DEPTH}) reached at ${dir}`);
    return [];
  }

  const results: string[] = [];
  const entries = safeReaddirSync(dir, dir);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(fullPath, depth + 1, log));
    } else if (entry.isFile() && /\.(test|spec)\.ts$/.test(entry.name)) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Check if an operation already has test coverage by scanning test file contents
 * for the operation name in GQL query/mutation/subscription strings.
 *
 * This avoids false negatives from creative naming (e.g., wallet-creation.test.ts
 * vs createWallet.test.ts) by searching the actual GQL strings in the file.
 *
 * Returns the path of the first matching file, or null if no test exists.
 */
export function findExistingTest(
  operationName: string,
  testFiles: string[],
  readFile: (filePath: string) => string = (p) => safeReadFileSync(p, path.dirname(p)),
): string | null {
  for (const filePath of testFiles) {
    const content = readFile(filePath);
    // Look for the operation name inside a gql template literal or string
    // Matches patterns like: mutation CreateWallet, query FetchWallet, etc.
    // Also matches the raw operation name in backtick template literals
    if (content.includes(operationName)) {
      return filePath;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Template generation
// ---------------------------------------------------------------------------

/**
 * Convert camelCase operation name to kebab-case for file naming.
 */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Capitalize the first letter of a string.
 */
function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * Calculate the relative import path from a test file to the src directory.
 *
 * Example: tests/contract/payment/createWallet.test.ts -> ../../../src
 */
export function calculateImportDepth(testFilePath: string, projectRoot: string): string {
  const testDir = path.dirname(testFilePath);
  const srcDir = path.join(projectRoot, 'src');
  const relativePath = path.relative(testDir, srcDir);
  return relativePath;
}

/**
 * Generate a GraphQL operation string for the template.
 * For operations with complex input types, generates a $input variable with TODO.
 */
function generateGqlOperation(op: ParsedOperation): string {
  const operationType = op.type;
  const operationNamePascal = capitalize(op.name);

  // We don't introspect input type fields — this is skeleton generation.
  // The TODO comment tells the developer to fill in the actual fields.
  return `const ${op.name.toUpperCase()}_${operationType.toUpperCase()} = gql\`
  ${operationType} ${operationNamePascal} {
    ${op.name} {
      # TODO: Add return fields from schema introspection
      __typename
    }
  }
\`;`;
}

/**
 * Generate a mutation-specific GQL string (mutations often take arguments).
 */
function generateMutationGql(op: ParsedOperation): string {
  const operationNamePascal = capitalize(op.name);

  return `const ${op.name.toUpperCase()}_MUTATION = gql\`
  mutation ${operationNamePascal}($input: ${operationNamePascal}Input!) {
    ${op.name}(input: $input) {
      # TODO: Add return fields from schema introspection
      __typename
    }
  }
\`;

// TODO: Define the input type based on schema introspection
// const sampleInput = { };`;
}

/**
 * Generate the full test file content for an operation.
 */
export function generateTestContent(op: ParsedOperation, importBase: string): string {
  const isMutation = op.type === 'mutation';
  const isSubscription = op.type === 'subscription';

  const gqlBlock = isMutation ? generateMutationGql(op) : generateGqlOperation(op);

  const subscriptionNote = isSubscription
    ? `\n * NOTE: Subscription testing requires a WebSocket client. This skeleton\n * provides the GQL definition but the test runner needs ws:// support.\n *`
    : '';

  return `/**
 * Contract Test — ${op.type} \`${op.name}\`
 * Module: ${op.module}
 *
 * Auto-generated test skeleton by Dino Test Scaffolder (Issue #5).
 * Fill in return fields, input variables, and assertions based on
 * live schema introspection.${subscriptionNote}
 *
 * @see src/reporters/operation-mapper.ts for operation registry
 */

import { gql } from 'graphql-request';
import { executeOperation } from '${importBase}/utils/graphql-client';

${gqlBlock}

describe('${capitalize(op.module)}: ${op.name}', () => {
  describe('Happy Path', () => {
    it('should execute ${op.name} successfully', async () => {
      // TODO: Add proper variables and assertions
      const result = await executeOperation<{ ${op.name}: unknown }>(
        ${isMutation ? `${op.name.toUpperCase()}_MUTATION` : `${op.name.toUpperCase()}_${op.type.toUpperCase()}`},${isMutation ? `\n        // TODO: { input: sampleInput },` : ''}
      );

      if (result.data) {
        expect(result.data.${op.name}).toBeDefined();
      } else {
        // If auth is required, we should get a specific error
        expect(result.errors).toBeDefined();
        expect(result.errors![0].message).toBeDefined();
      }
    });
  });

  describe('Auth Validation', () => {
    it('should reject unauthenticated ${op.name}', async () => {
      const result = await executeOperation<{ ${op.name}: unknown }>(
        ${isMutation ? `${op.name.toUpperCase()}_MUTATION` : `${op.name.toUpperCase()}_${op.type.toUpperCase()}`},
        ${isMutation ? 'undefined, // TODO: replace with { input: sampleInput }' : 'undefined,'}
        { authToken: '' }, // Explicit empty token to override env-based auth
      );

      expect(result.errors).toBeDefined();
      const errorMessage = result.errors![0].message.toLowerCase();
      expect(
        errorMessage.includes('unauthenticated') ||
          errorMessage.includes('unauthorized') ||
          errorMessage.includes('auth') ||
          errorMessage.includes('token'),
      ).toBe(true);
    });
  });
});
`;
}

// ---------------------------------------------------------------------------
// Core scaffolding engine
// ---------------------------------------------------------------------------

interface ProcessOperationContext {
  op: ParsedOperation;
  existingTestFiles: string[];
  cachedRead: (filePath: string) => string;
  testBaseDir: string;
  projectRoot: string;
  dryRun: boolean;
  result: ScaffoldResult;
  log: ScaffoldLogger;
}

async function processOperation(ctx: ProcessOperationContext): Promise<void> {
  const { op, existingTestFiles, cachedRead, testBaseDir, projectRoot, dryRun, result, log } = ctx;
  // Check for existing test coverage
  const existingFile = findExistingTest(op.name, existingTestFiles, cachedRead);
  if (existingFile) {
    result.skipped.push({
      operationName: op.name,
      reason: 'Test already exists',
      existingFile,
    });
    return;
  }

  // Build output file path: tests/contract/{module}/{operationName}.test.ts
  const moduleDir = path.join(testBaseDir, op.module);
  const fileName = `${toKebabCase(op.name)}.test.ts`;
  const filePath = path.join(moduleDir, fileName);

  // Calculate import depth
  const importBase = calculateImportDepth(filePath, projectRoot);

  // Generate test content
  const content = generateTestContent(op, importBase);

  if (dryRun) {
    result.created.push({
      operationName: op.name,
      operationType: op.type,
      module: op.module,
      filePath,
    });
    return;
  }

  // Write the file
  try {
    if (!safeExistsSync(moduleDir, testBaseDir)) {
      safeMkdirSync(moduleDir, testBaseDir);
    }

    // Never overwrite existing files
    if (safeExistsSync(filePath, testBaseDir)) {
      result.skipped.push({
        operationName: op.name,
        reason: 'File already exists (but operation name not found in content)',
        existingFile: filePath,
      });
      return;
    }

    safeWriteFileSync(filePath, content, testBaseDir);
    result.created.push({
      operationName: op.name,
      operationType: op.type,
      module: op.module,
      filePath,
    });

    log.info(`Created: ${filePath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push({
      operationName: op.name,
      error: message,
    });
    log.error(`Failed to create ${filePath}: ${message}`);
  }
}

/**
 * Scaffold test skeletons for untested operations.
 *
 * This is the primary agent tool. It:
 * 1. Parses the registry (from options)
 * 2. Scans existing test files for operation coverage
 * 3. Generates skeleton test files for untested operations
 * 4. Returns a structured report
 *
 * @param options - Configuration options (registry required)
 * @returns Structured result with created, skipped, and error counts
 */
export async function scaffoldTests(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const registry = options.registry;
  const log = options.logger ?? NOOP_LOG;
  const dryRun = options.dryRun ?? false;
  const clock = resolveClock(options.clock);
  const testBaseDir = path.join(projectRoot, options.testDir ?? 'tests/contract');

  const result: ScaffoldResult = {
    timestamp: clock.isoNow(),
    projectRoot,
    dryRun,
    created: [],
    skipped: [],
    errors: [],
    summary: {
      totalOperations: 0,
      created: 0,
      skipped: 0,
      errors: 0,
    },
  };

  // 1. Parse registry
  const allOps = parseRegistry(registry);

  // 2. Filter by module/type if specified
  let filteredOps = allOps;
  if (options.modules && options.modules.length > 0) {
    const moduleSet = new Set(options.modules);
    filteredOps = filteredOps.filter((op) => moduleSet.has(op.module));
  }
  if (options.types && options.types.length > 0) {
    const typeSet = new Set(options.types);
    filteredOps = filteredOps.filter((op) => typeSet.has(op.type));
  }

  result.summary.totalOperations = filteredOps.length;

  if (filteredOps.length === 0) {
    log.info('No operations match the filter criteria. Nothing to scaffold.');
    return result;
  }

  // 3. Collect existing test files and cache contents (read once, reuse for all operations)
  const existingTestFiles = collectTestFiles(testBaseDir, 0, log);
  log.info(`Found ${existingTestFiles.length} existing test files in ${testBaseDir}`);

  const contentCache = new Map<string, string>();
  const cachedRead = (filePath: string): string => {
    const cached = contentCache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }
    const content = safeReadFileSync(filePath, testBaseDir);
    contentCache.set(filePath, content);
    return content;
  };

  // 4. Process each operation
  for (const op of filteredOps) {
    await processOperation({
      op,
      existingTestFiles,
      cachedRead,
      testBaseDir,
      projectRoot,
      dryRun,
      result,
      log,
    });
  }

  // 5. Compute summary
  result.summary.created = result.created.length;
  result.summary.skipped = result.skipped.length;
  result.summary.errors = result.errors.length;

  // 6. Log summary
  log.info(
    `Scaffold complete: ${result.summary.created} created, ` +
      `${result.summary.skipped} skipped, ${result.summary.errors} errors ` +
      `(${result.summary.totalOperations} total operations${dryRun ? ', DRY RUN' : ''})`,
  );

  return result;
}
