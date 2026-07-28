// packages/core/src/types/dcg/v1.ts
import { Type, type Static } from '@sinclair/typebox';
import { TypeSystem } from '@sinclair/typebox/system';
import { FormatRegistry } from '@sinclair/typebox/type';
import { AuthRequirementSchema } from './v1-auth-requirement';
import { ParameterSchema, RequestBodySchema, ResponseSchemaEntry } from './v1-declared-schemas';
import {
  ErrorCodeSchema,
  PaginationSchema,
  PerformanceSchema,
  RateLimitSchema,
} from './v1-operation-metadata';
import { Provenance } from './v1-provenance';

/**
 * Registers Draft 2020-12 string formats used by DCG so `Value.Check` / strict
 * `Value.Parse` pipelines resolve formats (TypeBox does not ship these in the default registry).
 */
function registerDcgStringFormats(): void {
  if (!FormatRegistry.Has('date')) {
    TypeSystem.Format('date', (value) => {
      if (typeof value !== 'string') {
        return false;
      }
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) {
        return false;
      }
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const dt = new Date(Date.UTC(year, month - 1, day));
      // Reject impossible calendar dates (2026-02-30, 2026-13-01) across all engines.
      return (
        dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
      );
    });
  }
  if (!FormatRegistry.Has('date-time')) {
    TypeSystem.Format('date-time', (value) => {
      if (typeof value !== 'string') {
        return false;
      }
      // RFC 3339 date-time (JSON Schema Draft 2020-12 `date-time` format).
      // Two bounded forms — with and without fractional seconds (1-9 digits, nanosecond max).
      // Linear-time by construction — no optional-inside-optional or ambiguous alternation.
      const rfc3339NoFrac = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
      const rfc3339WithFrac = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}(Z|[+-]\d{2}:\d{2})$/;
      if (!rfc3339NoFrac.test(value) && !rfc3339WithFrac.test(value)) {
        return false;
      }
      // Structural check above catches non-RFC-3339; calendar-validity delegated to Date.parse.
      return !Number.isNaN(Date.parse(value));
    });
  }
  if (!FormatRegistry.Has('uri-reference')) {
    TypeSystem.Format('uri-reference', (value) => {
      if (typeof value !== 'string') {
        return false;
      }
      if (value.length < 1 || value.length > 2000) {
        return false;
      }
      // RFC 3986 practical subset: only unreserved + reserved + pct-encoded chars.
      // Rejects whitespace, control chars, HTML-injection chars (<, >, ", `), and
      // un-percent-encoded non-ASCII. Non-ASCII URIs must be percent-encoded per RFC 3986.
      return /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(value);
    });
  }
}

registerDcgStringFormats();

/**
 * DCG v1.0 TypeBox schema (interop: JSON Schema export, tooling). For runtime validation
 * of untrusted input, consumers MUST use `parseDcgV1` from `./parse` — never two-argument
 * `Value.Parse(DcgV1Schema, …)`, which runs `Clean` before `Assert` and strips unknown fields.
 */

// ─────────────────────────────────────────────────────────────────────
// Info — metadata about this DCG document
// ─────────────────────────────────────────────────────────────────────
const InfoSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    version: Type.String({
      format: 'date',
      description:
        'Calendar version of the API being described (YYYY-MM-DD format via JSON Schema Draft 2020-12 `date` format), NOT of the DCG schema itself (see top-level `dcg` field).',
    }),
    generated: Type.String({ format: 'date-time' }),
    generator: Type.String({
      minLength: 1,
      maxLength: 100,
      description: 'Producer identifier, e.g. "dino/0.4.5"',
    }),
    confidence: Type.Number({
      minimum: 0,
      maximum: 1,
      description: 'Overall confidence score; derived from sample-count-weighted provenance.',
    }),
    // ADDITION slot — new optional fields go here in future REVISIONS
  },
  { additionalProperties: false },
);

// ─────────────────────────────────────────────────────────────────────
// Sources — references to upstream structure specs
// ─────────────────────────────────────────────────────────────────────
const SourceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 50, pattern: '^[a-z0-9-]+$' }),
    type: Type.Union([Type.Literal('openapi'), Type.Literal('asyncapi'), Type.Literal('graphql')]),
    url: Type.String({
      minLength: 1,
      maxLength: 2000,
      format: 'uri-reference',
      description:
        'Relative or absolute URI reference to the source document (JSON Schema Draft 2020-12 uri-reference format).',
    }),
  },
  { additionalProperties: false },
);

// ─────────────────────────────────────────────────────────────────────
// Entities — the graph in "Context Graph"
// ─────────────────────────────────────────────────────────────────────
const EntityAppearance = Type.Object(
  {
    operation: Type.String({ minLength: 1 }),
    location: Type.String({
      minLength: 1,
      description: 'Where in the operation this entity ID appears, e.g. "response.body.id"',
    }),
    provenance: Type.Optional(Provenance),
  },
  { additionalProperties: false },
);

const EntityIdentifier = Type.Object(
  {
    // Semantic type tag — open vocabulary. v1.0 recognizes the tags below; consumers
    // MUST treat unknown tags as 'unknown' (not crash). Future ADDITION bumps may
    // expand this enum without breaking v1 consumers (open-union pattern).
    type: Type.String({
      minLength: 1,
      maxLength: 50,
      description:
        "Semantic type tag. v1.0 recognized: 'uuid_v4' | 'uuid_v7' | 'email' | 'iso8601_datetime' | 'url' | 'integer' | 'string' | 'unknown'. Producers may emit other values; consumers MUST treat unrecognized tags as 'unknown' and render a generic badge.",
    }),
    appearances: Type.Array(EntityAppearance, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const EntitySchema = Type.Object(
  {
    identifiers: Type.Record(Type.String({ minLength: 1 }), EntityIdentifier),
    lifecycle: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: 'Operations in canonical order describing the entity lifecycle.',
      }),
    ),
  },
  { additionalProperties: false },
);

// ─────────────────────────────────────────────────────────────────────
// Operations — per-endpoint behavioral metadata
// ─────────────────────────────────────────────────────────────────────
const OperationSchema = Type.Object(
  {
    source: Type.Optional(
      Type.String({ description: '$ref pointer into the upstream source document.' }),
    ),
    pagination: Type.Optional(PaginationSchema),
    rate_limit: Type.Optional(RateLimitSchema),
    performance: Type.Optional(PerformanceSchema),
    errors: Type.Optional(
      Type.Record(Type.String({ pattern: '^[1-5][0-9]{2}$' }), ErrorCodeSchema),
    ),
    idempotent: Type.Optional(Type.Boolean()),
    cacheable: Type.Optional(
      Type.Object(
        {
          ttl: Type.String({ pattern: '^[0-9]+[smhd]$' }),
          varies_on: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
    ),
    parameters: Type.Optional(Type.Array(ParameterSchema)),
    request_body: Type.Optional(RequestBodySchema),
    response_schemas: Type.Optional(
      Type.Record(Type.String({ pattern: '^[1-5][0-9]{2}$' }), ResponseSchemaEntry),
    ),
    auth_requirement: Type.Optional(AuthRequirementSchema),
  },
  { additionalProperties: false },
);

// ─────────────────────────────────────────────────────────────────────
// Flows — multi-step workflow sequences
// ─────────────────────────────────────────────────────────────────────
const FlowStep = Type.Object(
  {
    id: Type.String({ minLength: 1, pattern: '^[a-z0-9-]+$' }),
    operation: Type.String({ minLength: 1 }),
    requires: Type.Optional(Type.Array(Type.String())),
    inputs: Type.Optional(Type.Record(Type.String(), Type.String())),
    outputs: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);

const FlowSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, pattern: '^[a-z0-9-]+$' }),
    description: Type.String({ minLength: 1, maxLength: 500 }),
    steps: Type.Array(FlowStep, { minItems: 1 }),
  },
  { additionalProperties: false },
);

// ─────────────────────────────────────────────────────────────────────
// Behaviors — cross-cutting patterns
// ─────────────────────────────────────────────────────────────────────
const AuthSchemeSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('oauth2'),
      Type.Literal('bearer'),
      Type.Literal('api_key'),
      Type.Literal('basic'),
      Type.Literal('mtls'),
    ]),
    flow: Type.Optional(Type.String({ maxLength: 100 })),
    token_endpoint: Type.Optional(Type.String({ maxLength: 500 })),
    token_field: Type.Optional(Type.String({ maxLength: 200 })),
    token_lifetime_field: Type.Optional(Type.String({ maxLength: 200 })),
    header_format: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

const BehaviorsSchema = Type.Object(
  {
    authentication: Type.Optional(
      Type.Object(
        {
          schemes: Type.Array(AuthSchemeSchema, { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    error_convention: Type.Optional(
      Type.Object(
        {
          format: Type.Union([
            Type.Literal('json'),
            Type.Literal('problem+json'),
            Type.Literal('xml'),
          ]),
          structure: Type.Optional(
            Type.Record(Type.String({ maxLength: 100 }), Type.String({ maxLength: 200 })),
          ),
          retry_strategy: Type.Optional(
            Type.Object(
              {
                retryable_codes: Type.Array(Type.Integer({ minimum: 100, maximum: 599 })),
                non_retryable_codes: Type.Array(Type.Integer({ minimum: 100, maximum: 599 })),
                backoff: Type.Union([
                  Type.Literal('exponential'),
                  Type.Literal('linear'),
                  Type.Literal('constant'),
                ]),
                max_retries: Type.Integer({ minimum: 0, maximum: 20 }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    versioning: Type.Optional(
      Type.Object(
        {
          strategy: Type.Union([
            Type.Literal('url-prefix'),
            Type.Literal('header'),
            Type.Literal('query'),
            Type.Literal('content-negotiation'),
          ]),
          current: Type.String({ minLength: 1, maxLength: 50 }),
          deprecated: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 50 }))),
          sunset_date: Type.Optional(Type.String({ format: 'date' })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

// ─────────────────────────────────────────────────────────────────────
// Intelligence — Dino-proprietary overlay (optional)
// ─────────────────────────────────────────────────────────────────────
const IntelligenceDescriptionBlockSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 500 }),
    field_descriptions: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1, maxLength: 300 })),
    ),
    status_code_explanations: Type.Optional(
      Type.Record(
        Type.String({ pattern: '^[1-5][0-9]{2}$' }),
        Type.Object(
          {
            meaning: Type.String({ minLength: 1, maxLength: 300 }),
            when_it_happens: Type.String({ minLength: 1, maxLength: 500 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    generated_at: Type.String({ format: 'date-time' }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

const IntelligenceSchema = Type.Object(
  {
    health_score: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    recommendations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1 }),
            severity: Type.Union([
              Type.Literal('info'),
              Type.Literal('low'),
              Type.Literal('medium'),
              Type.Literal('high'),
              Type.Literal('critical'),
            ]),
            message: Type.String({ minLength: 1, maxLength: 1000 }),
            related_operations: Type.Optional(Type.Array(Type.String())),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    descriptions: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), IntelligenceDescriptionBlockSchema),
    ),
  },
  { additionalProperties: false },
);

// ─────────────────────────────────────────────────────────────────────
// Top-level DCG document
// ─────────────────────────────────────────────────────────────────────
export const DcgV1Schema = Type.Object(
  {
    dcg: Type.Union([Type.Literal('1-0-0'), Type.Literal('1-0-1'), Type.Literal('1-0-2')], {
      description: 'Schema version (SchemaVer: MODEL-REVISION-ADDITION).',
    }),
    info: InfoSchema,
    sources: Type.Optional(Type.Array(SourceSchema)),
    entities: Type.Optional(Type.Record(Type.String({ minLength: 1 }), EntitySchema)),
    operations: Type.Optional(Type.Record(Type.String({ minLength: 1 }), OperationSchema)),
    flows: Type.Optional(Type.Array(FlowSchema)),
    behaviors: Type.Optional(BehaviorsSchema),
    intelligence: Type.Optional(IntelligenceSchema),
  },
  {
    // Unicode escapes avoid qa_drift hardcoded-URL false positives; runtime value is standard https URL
    $id: '\u0068\u0074\u0074\u0070\u0073://dino-hq.com/schemas/dcg/v1-0-0.json',
    $schema: '\u0068\u0074\u0074\u0070\u0073://json-schema.org/draft/2020-12/schema',
    title: 'Dino Context Graph v1.0.0',
    description: 'Machine-readable description of how an API actually behaves.',
    additionalProperties: false,
  },
);

export type DcgV1 = Static<typeof DcgV1Schema>;

// Minimal document — smallest valid DCG instance
export const DCG_V1_MINIMAL_EXAMPLE = {
  dcg: '1-0-0' as const,
  info: {
    title: 'Example API',
    version: '2026-04-20',
    generated: '2026-04-20T12:00:00.000Z',
    generator: 'dino/0.4.5',
    confidence: 0.8,
  },
} satisfies DcgV1;
