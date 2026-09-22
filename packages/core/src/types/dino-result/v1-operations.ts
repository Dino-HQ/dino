// packages/core/src/types/dino-result/v1-operations.ts
import { Type } from '@sinclair/typebox';
import {
  EnvelopeLevelSchema,
  LedgerSchema,
  NonNegativeInt,
  ProtocolSchema,
  ToolNameSchema,
} from './v1-common';

const Text = (max: number) => Type.String({ maxLength: max });
const JsonSchemaObject = Type.Record(Type.String(), Type.Unknown());

/** Mirrors `OperationParameter` / `OperationRequestBody` / `OperationResponseSchema` (`types/operation.ts`). */
export const OperationParameterSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    in: Type.Union([
      Type.Literal('path'),
      Type.Literal('query'),
      Type.Literal('header'),
      Type.Literal('cookie'),
    ]),
    required: Type.Optional(Type.Boolean()),
    description: Type.Optional(Text(2048)),
    schema: Type.Optional(JsonSchemaObject),
    deprecated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const OperationRequestBodySchema = Type.Object(
  {
    contentType: Type.String({ minLength: 1, maxLength: 200 }),
    schema: Type.Optional(JsonSchemaObject),
    required: Type.Optional(Type.Boolean()),
    description: Type.Optional(Text(2048)),
  },
  { additionalProperties: false },
);

export const OperationResponseSchemaSchema = Type.Object(
  {
    description: Type.Optional(Text(2048)),
    contentType: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    schema: Type.Optional(JsonSchemaObject),
  },
  { additionalProperties: false },
);

/** One (operation × tool) row — two axes, never one enum (spec §4.1, review M‑3). */
export const OperationToolRowSchema = Type.Union([
  Type.Object(
    {
      tool: ToolNameSchema,
      disposition: Type.Literal('excluded'),
      /** The 1.0 exclusion vocabulary — never an invented disposition (closure M‑1). */
      reason: Type.Union([
        Type.Literal('not-selected'),
        Type.Literal('not-applicable-protocol'),
        Type.Literal('requires-roles'),
        Type.Literal('not-planned'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: ToolNameSchema,
      disposition: Type.Literal('planned'),
      cardinality: Type.Literal('unknown'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: ToolNameSchema,
      disposition: Type.Literal('planned'),
      cardinality: Type.Literal('known'),
      ledger: LedgerSchema,
      severity: EnvelopeLevelSchema,
      findingCount: NonNegativeInt,
      examples: Type.Array(Text(2048)),
      classifications: Type.Array(Type.String({ minLength: 1, maxLength: 200 })),
    },
    { additionalProperties: false },
  ),
]);

export const ObservedAuthSchema = Type.Object(
  {
    rolesTested: Type.Array(Type.String({ maxLength: 200 })),
    minimumRole: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    unauthenticated: Type.Union([
      Type.Literal('allowed'),
      Type.Literal('denied'),
      Type.Literal('inconclusive'),
    ]),
  },
  { additionalProperties: false },
);

export const ObservedResponsesSchema = Type.Object(
  {
    statusCodes: Type.Record(
      Type.String({ pattern: String.raw`^[1-5]\d{2}$` }),
      Type.Object(
        { contentType: Type.Optional(Type.String({ maxLength: 200 })) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** ONE collection = the enumerable scope; only real API operations (never type-field rows, review C‑8). */
export const OperationSchema = Type.Object(
  {
    protocol: ProtocolSchema,
    /** GraphQL `kind:name`; REST `METHOD path` (D14). */
    operationKey: Type.String({ minLength: 1, maxLength: 512 }),
    name: Type.String({ minLength: 1, maxLength: 512 }),
    kind: Type.Optional(
      Type.Union([Type.Literal('query'), Type.Literal('mutation'), Type.Literal('subscription')]),
    ),
    module: Type.String({ minLength: 1, maxLength: 200 }),
    /** `null` when no discovery source supplied the fact (a registry-only operation, review 4 C‑4). */
    deprecated: Type.Union([Type.Boolean(), Type.Null()]),
    schemaDescription: Type.Union([Text(4096), Type.Null()]),
    /** `unknown` when the name-keyed coverage source cannot tell this operation from a same-name one (review 5 C‑1). */
    coverageStatus: Type.Union([
      Type.Literal('documented-and-tested'),
      Type.Literal('documented-only'),
      Type.Literal('absent'),
      Type.Literal('unknown'),
    ]),
    args: Type.Union([
      Type.Array(
        Type.Object(
          { name: Type.String({ maxLength: 200 }), type: Type.String({ maxLength: 512 }), isRequired: Type.Boolean() },
          { additionalProperties: false },
        ),
      ),
      Type.Null(),
    ]),
    returnType: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
    parameters: Type.Optional(Type.Array(OperationParameterSchema)),
    requestBody: Type.Optional(OperationRequestBodySchema),
    responseSchemas: Type.Optional(Type.Record(Type.String(), OperationResponseSchemaSchema)),
    tools: Type.Array(OperationToolRowSchema),
    worstSeverity: EnvelopeLevelSchema,
    /** `null` whenever the operation is UNTESTED (D2) or its structure is unknown (`deprecated: null`, review 4 C‑4). */
    healthScore: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
    tested: Type.Boolean(),
    executionCoverage: Type.Union([
      Type.Literal('tested'),
      Type.Literal('partially-tested'),
      Type.Literal('not-tested'),
    ]),
    executionCoverageReason: Type.Optional(Text(2048)),
    observedAuth: Type.Optional(ObservedAuthSchema),
    observedResponses: Type.Optional(ObservedResponsesSchema),
  },
  { additionalProperties: false },
);
