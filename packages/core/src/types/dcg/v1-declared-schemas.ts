import { Type } from '@sinclair/typebox';
import { Provenance } from './v1-provenance';

export const ParameterSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    in: Type.Union([
      Type.Literal('path'),
      Type.Literal('query'),
      Type.Literal('header'),
      Type.Literal('cookie'),
    ]),
    required: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    provenance: Type.Optional(Provenance),
  },
  { additionalProperties: false },
);

export const RequestBodySchema = Type.Object(
  {
    content_type: Type.String({ minLength: 1, maxLength: 200 }),
    schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    required: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    provenance: Type.Optional(Provenance),
  },
  { additionalProperties: false },
);

export const ResponseSchemaEntry = Type.Object(
  {
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    content_type: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    provenance: Type.Optional(Provenance),
  },
  { additionalProperties: false },
);
