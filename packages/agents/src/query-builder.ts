/**
 * Project Dino — Smart Query Builder
 *
 * Generates schema-valid GraphQL mutations from introspection data.
 * Produces documents with proper variable declarations, argument passes,
 * selection sets, and minimal stub values — enough to pass variable coercion
 * and reach the auth middleware layer.
 *
 * Why this exists:
 * Bare mutations like `mutation Foo { foo }` fail GraphQL schema validation
 * because they lack required arguments and selection sets. Even with correct
 * type declarations, empty {} stubs fail Apollo's variable coercion because
 * required fields are missing. This module recursively populates input objects
 * using introspected field definitions and enum values.
 *
 * @see Issue #145 — Smart Query Builder
 */

import type { ArgInfo } from './fuzz-strategies';
import { recordGet, type GraphQLOperation, type InputTypeField } from '@dino/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmartMutation {
  /** The GraphQL document string with variable declarations and selection set. */
  document: string;
  /** Stub variable values to pass with the request. */
  variables: Record<string, unknown>;
}

/** Type maps from introspection — optional, enables recursive stub generation. */
export interface TypeMaps {
  inputTypes?: Record<string, InputTypeField[]>;
  enumTypes?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Stub value generation
// ---------------------------------------------------------------------------

const KNOWN_SCALARS = new Set(['boolean', 'string', 'int', 'float', 'id']);

/**
 * Recursively populate required fields for an INPUT_OBJECT type.
 * Tracks visited types to prevent infinite recursion on circular references.
 */
function populateInputObject(
  baseType: string,
  fields: InputTypeField[],
  typeMaps: TypeMaps,
  visited: Set<string>,
): Record<string, unknown> {
  if (visited.has(baseType)) return {};
  visited.add(baseType);

  const obj: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.isRequired) {
      obj[field.name] = generateStubValue(field.type, typeMaps, visited);
    }
  }
  visited.delete(baseType);
  return obj;
}

/**
 * Generate a minimal stub value for a GraphQL type string.
 *
 * When type maps are provided (from introspection), recursively populates
 * input object fields and picks the first enum value. Without maps, falls
 * back to empty objects (which may fail variable coercion).
 *
 * Tracks visited types to prevent infinite recursion on circular input types.
 */
export function generateStubValue(
  argType: string,
  typeMaps?: TypeMaps,
  visited?: Set<string>,
): unknown {
  // Strip non-null marker for base type matching
  const baseType = argType.replaceAll(/!/g, '');

  // List types → empty array
  if (baseType.startsWith('[')) return [];

  // Scalar types
  const lower = baseType.toLowerCase();
  if (lower === 'string') return '';
  if (lower === 'int') return 0;
  if (lower === 'float') return 0;
  if (lower === 'boolean') return false;
  if (lower === 'id') return 'stub-id';

  if (!typeMaps) return {};

  // Enum types — pick first value
  const enumValues = recordGet(typeMaps.enumTypes ?? {}, baseType);
  if (enumValues) return enumValues.length > 0 ? enumValues[0] : null;

  // Input object types — recursively populate required fields
  const inputFields = recordGet(typeMaps.inputTypes ?? {}, baseType);
  if (inputFields) {
    return populateInputObject(baseType, inputFields, typeMaps, visited ?? new Set<string>());
  }

  // Fallback: unknown named type → empty object (best effort)
  return {};
}

// ---------------------------------------------------------------------------
// Scalar detection
// ---------------------------------------------------------------------------

/** Returns true when the return type is a known scalar (no subfields). */
function isScalarReturn(returnType?: string): boolean {
  if (!returnType) return false;
  const base = returnType.replaceAll(/!/g, '').replaceAll(/[[\]]/g, '').toLowerCase();
  return KNOWN_SCALARS.has(base);
}

// ---------------------------------------------------------------------------
// Smart mutation builder
// ---------------------------------------------------------------------------

/**
 * Build a schema-valid GraphQL operation (mutation or query) with variable
 * declarations, argument passes, stub variables, and an appropriate selection set.
 *
 * When returnType is a known scalar (Boolean!, String!, etc.), the selection
 * set is omitted because scalars have no subfields. For object return types,
 * `{ __typename }` is appended as a minimal selection set.
 */
export function buildSmartMutation(
  operationName: string,
  args: ArgInfo[],
  returnType?: string,
  typeMaps?: TypeMaps,
  operationType: 'mutation' | 'query' = 'mutation',
): SmartMutation {
  if (!operationName) {
    return { document: `${operationType} { __typename }`, variables: {} };
  }
  const capitalName = operationName[0].toUpperCase() + operationName.slice(1);
  const selection = isScalarReturn(returnType) ? '' : ' { __typename }';

  if (args.length === 0) {
    return {
      document: `${operationType} ${capitalName} { ${operationName}${selection} }`,
      variables: {},
    };
  }

  const varDecls = args.map((a) => `$${a.name}: ${a.type}`).join(', ');
  const argPasses = args.map((a) => `${a.name}: $${a.name}`).join(', ');

  const variables: Record<string, unknown> = {};
  for (const arg of args) {
    variables[arg.name] = generateStubValue(arg.type, typeMaps);
  }

  return {
    document: `${operationType} ${capitalName}(${varDecls}) { ${operationName}(${argPasses})${selection} }`,
    variables,
  };
}

// ---------------------------------------------------------------------------
// Introspection arg resolver
// ---------------------------------------------------------------------------

/**
 * Look up an operation's arguments from introspection data.
 *
 * Returns the args as ArgInfo[] (compatible with fuzz-strategies).
 * Returns empty array if the operation is not found in introspection data.
 */
export function resolveQueryArgs(
  operationName: string,
  introspectionOps: GraphQLOperation[],
): ArgInfo[] {
  const op = introspectionOps.find((o) => o.name === operationName);
  if (!op) return [];

  return op.args.map((arg) => ({
    name: arg.name,
    type: arg.type,
    isRequired: arg.isRequired,
  }));
}

// ---------------------------------------------------------------------------
// Default arg guesser (fallback when no introspection data)
// ---------------------------------------------------------------------------

/**
 * Guess the most common arg pattern when introspection data is unavailable.
 *
 * Most GraphQL mutations follow the pattern:
 *   mutation Foo($input: FooInput!) { foo(input: $input) { ... } }
 *
 * This is the same heuristic used by the input fuzzer's defaultArgResolver.
 */
export function guessOperationArgs(operationName: string): ArgInfo[] {
  if (!operationName) return [];

  const capitalName = operationName[0].toUpperCase() + operationName.slice(1);
  return [
    {
      name: 'input',
      type: `${capitalName}Input!`,
      isRequired: true,
    },
  ];
}
