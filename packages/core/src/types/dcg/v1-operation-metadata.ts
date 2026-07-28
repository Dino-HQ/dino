import { Type } from '@sinclair/typebox';

export const PaginationSchema = Type.Object(
  {
    style: Type.Union([
      Type.Literal('cursor'),
      Type.Literal('offset'),
      Type.Literal('page'),
      Type.Literal('token'),
      Type.Literal('link-header'),
    ]),
    cursor_param: Type.Optional(Type.String()),
    cursor_field: Type.Optional(Type.String()),
    page_size_param: Type.Optional(Type.String()),
    max_page_size: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const RateLimitSchema = Type.Object(
  {
    window: Type.String({
      pattern: '^[0-9]+[smhd]$',
      description: 'Duration literal: "60s", "15m", "1h", "1d"',
    }),
    limit: Type.Integer({ minimum: 1 }),
    limit_header: Type.Optional(Type.String()),
    remaining_header: Type.Optional(Type.String()),
    retry_after_header: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PerformanceSchema = Type.Object(
  {
    p50_ms: Type.Optional(Type.Integer({ minimum: 0 })),
    p95_ms: Type.Optional(Type.Integer({ minimum: 0 })),
    p99_ms: Type.Optional(Type.Integer({ minimum: 0 })),
    observed_window: Type.Optional(
      Type.String({
        pattern: String.raw`^\d{4}-\d{2}-\d{2}/\d{4}-\d{2}-\d{2}$`,
        description: 'ISO 8601 date interval, e.g. "2026-04-12/2026-04-19"',
      }),
    ),
  },
  { additionalProperties: false },
);

export const ErrorCodeSchema = Type.Object(
  {
    meaning: Type.String({ minLength: 1, maxLength: 500 }),
    resolution: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
