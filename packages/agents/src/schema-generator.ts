/**
 * Project Dino — GraphQL Schema → Zod Converter
 *
 * Introspects the live API to fetch full type definitions, then converts
 * GraphQL types into Zod schemas for runtime response validation.
 *
 * Design:
 * - Deeper introspection query than introspect.ts (fetches type fields, not just names)
 * - Filters out __-prefixed built-in types
 * - Supports OBJECT, SCALAR, ENUM, NON_NULL, LIST, UNION, INTERFACE
 * - Shared MAX_DEPTH = 5 constant (used by both Zod generator and query builder)
 * - Schema caching to avoid regenerating the same type
 * - z.object({...}).strict() to detect extra fields
 *
 * @see Issue #8 — Response Schema Validation with Zod
 */

import { z, type ZodType } from 'zod';
import { GraphQLClient, gql } from 'graphql-request';
import { recordGet, resolveAndValidateDNS } from '@dino/core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum recursion depth for both Zod schema generation and query field
 * selection. Both sides MUST use this same constant to stay in sync.
 */
export const MAX_DEPTH = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchemaGeneratorLogger {
  info: (msg: string) => void;
}

const NOOP_LOG: SchemaGeneratorLogger = { info: () => {} };

/** Options for introspectFullTypes (host provides endpoint/config). */
export interface IntrospectTypesOptions {
  endpoint: string;
  timeout?: number;
  authToken?: string;
  logger?: SchemaGeneratorLogger;
}

export interface GQLField {
  name: string;
  type: GQLTypeRef;
}

export interface GQLTypeRef {
  kind: string;
  name: string | null;
  ofType: GQLTypeRef | null;
}

export interface GQLType {
  name: string;
  kind: string;
  fields: GQLField[] | null;
  enumValues: Array<{ name: string }> | null;
  possibleTypes: Array<{ name: string }> | null;
}

export type TypeMap = Map<string, GQLType>;

// ---------------------------------------------------------------------------
// Introspection query (deeper than introspect.ts)
// ---------------------------------------------------------------------------

/**
 * 4-level deep type ref fragment. Covers NON_NULL(LIST(NON_NULL(OBJECT)))
 * which is the deepest wrapper nesting seen in practice.
 */
const FULL_TYPE_QUERY = gql`
  query DinoFullTypeIntrospection {
    __schema {
      types {
        name
        kind
        fields {
          name
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
        enumValues {
          name
        }
        possibleTypes {
          name
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/**
 * Fetch all types from the live GraphQL schema.
 * Filters out built-in `__`-prefixed types (e.g. __Schema, __Type).
 * Caller passes endpoint/config via options (no getEnvironment in package).
 */
export async function introspectFullTypes(options: IntrospectTypesOptions): Promise<TypeMap> {
  const { endpoint, timeout = 30_000, authToken, logger = NOOP_LOG } = options;

  logger.info(`[SchemaGenerator] Introspecting types from: ${endpoint}`);

  const dnsCheck = await resolveAndValidateDNS(endpoint);
  if (!dnsCheck.allowed) {
    throw new Error(`SSRF blocked: endpoint failed DNS validation (${dnsCheck.reason})`);
  }

  const client = new GraphQLClient(endpoint, {
    signal: AbortSignal.timeout(timeout),
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await client.request<{ __schema: { types: any[] } }>(FULL_TYPE_QUERY);

  const typeMap: TypeMap = new Map();

  for (const t of data.__schema.types) {
    // Filter out GraphQL built-in introspection types
    if (typeof t.name === 'string' && t.name.startsWith('__')) continue;
    if (!t.name) continue;

    typeMap.set(t.name, {
      name: t.name,
      kind: t.kind,
      fields: t.fields ?? null,
      enumValues: t.enumValues ?? null,
      possibleTypes: t.possibleTypes ?? null,
    });
  }

  logger.info(`[SchemaGenerator] Found ${typeMap.size} types (excluding built-ins)`);
  return typeMap;
}

// ---------------------------------------------------------------------------
// Scalar mapping
// ---------------------------------------------------------------------------

const SCALAR_MAP: Record<string, ZodType> = {
  String: z.string(),
  Int: z.number(),
  Float: z.number(),
  Boolean: z.boolean(),
  ID: z.string(),
};

// ---------------------------------------------------------------------------
// Zod schema generation
// ---------------------------------------------------------------------------

/**
 * Unwrap a GQL type reference to its leaf kind/name.
 * Returns { kind, name, isList, isNonNull } so the caller
 * can decide wrapping.
 *
 * Note: Handles NON_NULL(LIST(NON_NULL(X))) which covers all standard
 * GraphQL patterns. Does NOT support nested lists (LIST(LIST(X))) as
 * these are extremely rare in real schemas.
 */
function unwrapTypeRef(ref: GQLTypeRef): {
  kind: string;
  name: string | null;
  isList: boolean;
  isNonNull: boolean;
} {
  let isList = false;
  let isNonNull = false;
  let current: GQLTypeRef | null = ref;

  // Peel off outermost NON_NULL
  if (current.kind === 'NON_NULL') {
    isNonNull = true;
    current = current.ofType;
  }

  // Peel off LIST
  if (current?.kind === 'LIST') {
    isList = true;
    current = current.ofType;
    // LIST items can also be NON_NULL
    if (current?.kind === 'NON_NULL') {
      current = current.ofType;
    }
  }

  return {
    kind: current?.kind ?? 'SCALAR',
    name: current?.name ?? null,
    isList,
    isNonNull,
  };
}

/** Resolve ENUM values to a Zod schema. */
function zodForEnum(values: Array<{ name: string }>): ZodType {
  const names = values.map((v) => v.name);
  if (names.length === 0) return z.string();
  if (names.length === 1) return z.literal(names[0]);
  return z.enum(names as [string, ...string[]]);
}

/** Map a single GQL field definition to a Zod field schema. */
function zodForField(
  field: GQLField,
  typeMap: TypeMap,
  depth: number,
  seen: Map<string, ZodType>,
): ZodType {
  const unwrapped = unwrapTypeRef(field.type);
  let schema = generateZodSchema(unwrapped.name ?? 'String', typeMap, depth + 1, seen);
  if (unwrapped.isList) schema = z.array(schema);
  if (!unwrapped.isNonNull) schema = schema.nullable().optional();
  return schema;
}

/**
 * Generate a Zod schema for a GraphQL type.
 *
 * @param typeName - The GraphQL type name (e.g., "Wallet", "Post")
 * @param typeMap  - Full type map from introspection
 * @param depth    - Current recursion depth (starts at 0)
 * @param seen     - Previously resolved schemas (avoids duplicating work on
 *                   recursive types). Omit for one-off single-type calls.
 * @returns Zod schema matching the GraphQL type definition
 */
function zodForUnionOrInterface(
  gqlType: GQLType,
  typeMap: TypeMap,
  depth: number,
  resolved: Map<string, ZodType>,
): ZodType {
  const members = (gqlType.possibleTypes ?? []).map((pt) =>
    generateZodSchema(pt.name, typeMap, depth + 1, resolved),
  );
  if (members.length === 0) return z.unknown();
  if (members.length === 1) return members[0];
  return z.union(members as [ZodType, ZodType, ...ZodType[]]);
}

function zodForObject(
  typeName: string,
  gqlType: GQLType,
  typeMap: TypeMap,
  depth: number,
  resolved: Map<string, ZodType>,
): ZodType {
  resolved.set(
    typeName,
    z.lazy(() => resolved.get(typeName) ?? z.unknown()),
  ); // circular-ref: deferred lookup resolves to final schema (fallback guards against build failure)
  const shape: Record<string, ZodType> = {};
  for (const field of gqlType.fields!)
    shape[field.name] = zodForField(field, typeMap, depth, resolved);
  shape['__typename'] = z.string().optional(); // always present in union queries
  const objectSchema = z.object(shape).strict();
  resolved.set(typeName, objectSchema);
  return objectSchema;
}

export function generateZodSchema(
  typeName: string,
  typeMap: TypeMap,
  depth: number = 0,
  seen?: Map<string, ZodType>,
): ZodType {
  const resolved = seen ?? new Map<string, ZodType>();

  if (depth >= MAX_DEPTH) return z.unknown();
  if (resolved.has(typeName)) return resolved.get(typeName)!;
  const scalarSchema = recordGet(SCALAR_MAP, typeName);
  if (scalarSchema) return scalarSchema;

  const gqlType = typeMap.get(typeName);
  if (!gqlType) return z.unknown();

  if (gqlType.kind === 'ENUM' && gqlType.enumValues) return zodForEnum(gqlType.enumValues);

  if ((gqlType.kind === 'UNION' || gqlType.kind === 'INTERFACE') && gqlType.possibleTypes) {
    return zodForUnionOrInterface(gqlType, typeMap, depth, resolved);
  }

  if (gqlType.kind === 'OBJECT' && gqlType.fields) {
    return zodForObject(typeName, gqlType, typeMap, depth, resolved);
  }

  return z.unknown();
}

// ---------------------------------------------------------------------------
// Query builder (depth-synced with Zod generator)
// ---------------------------------------------------------------------------

/**
 * Build a field selection set for a GQL type, respecting the same
 * MAX_DEPTH limit as the Zod schema generator.
 *
 * @param typeName - Root type to select fields from
 * @param typeMap  - Full type map
 * @param depth    - Current depth (starts at 0)
 * @param visited  - Set of visited type names (circular reference guard)
 * @returns GraphQL selection string (e.g., "{ id name wallet { id balance } }")
 */
function selectFieldEntry(
  field: GQLField,
  typeMap: TypeMap,
  depth: number,
  visited: Set<string>,
): string {
  const unwrapped = unwrapTypeRef(field.type);
  const leafName = unwrapped.name;

  // Scalar or enum — just select the field name
  if (!leafName || recordGet(SCALAR_MAP, leafName) || typeMap.get(leafName)?.kind === 'ENUM') {
    return field.name;
  }

  // UNION/INTERFACE — use inline fragments
  const leafType = typeMap.get(leafName);
  if (leafType && (leafType.kind === 'UNION' || leafType.kind === 'INTERFACE')) {
    const fragments = buildUnionSelection(leafType, typeMap, depth + 1, new Set(visited));
    return fragments ? `${field.name} { __typename ${fragments} }` : `${field.name} { __typename }`;
  }

  // OBJECT — recurse
  const nested = buildFieldSelection(leafName, typeMap, depth + 1, new Set(visited));
  return nested ? `${field.name} ${nested}` : field.name;
}

export function buildFieldSelection(
  typeName: string,
  typeMap: TypeMap,
  depth = 0,
  visited: Set<string> = new Set(),
): string {
  if (depth >= MAX_DEPTH) return '';
  if (visited.has(typeName)) return '';

  const gqlType = typeMap.get(typeName);
  if (!gqlType?.fields) return '';

  visited.add(typeName);

  const selections = gqlType.fields.map((field) =>
    selectFieldEntry(field, typeMap, depth, visited),
  );

  if (selections.length === 0) return '';
  return `{ ${selections.join(' ')} }`;
}

/**
 * Build inline fragment selections for UNION/INTERFACE types.
 */
function buildUnionSelection(
  unionType: GQLType,
  typeMap: TypeMap,
  depth: number,
  visited: Set<string>,
): string {
  if (!unionType.possibleTypes) return '';

  const fragments: string[] = [];
  for (const pt of unionType.possibleTypes) {
    const sel = buildFieldSelection(pt.name, typeMap, depth, new Set(visited));
    if (sel) {
      fragments.push(`... on ${pt.name} ${sel}`);
    }
  }

  return fragments.join(' ');
}
