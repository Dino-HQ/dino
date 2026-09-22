// packages/core/src/types/dino-result/v1-findings.ts
import { Type } from '@sinclair/typebox';
import { ProtocolSchema, SeverityLevelSchema, ToolNameSchema } from './v1-common';

/** Discriminated finding subject — never a fabricated operation key (spec §6, review C‑4). */
export const FindingTargetSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('operation'),
      protocol: ProtocolSchema,
      operationKey: Type.String({ minLength: 1, maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('schema-element'),
      elementKey: Type.String({ minLength: 1, maxLength: 512 }),
      parentType: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('run'), tool: ToolNameSchema },
    { additionalProperties: false },
  ),
]);

export const FindingSchema = Type.Object(
  {
    tool: ToolNameSchema,
    target: FindingTargetSchema,
    authState: Type.Optional(Type.String({ maxLength: 200 })),
    classification: Type.String({ minLength: 1, maxLength: 200 }),
    normalizedLevel: SeverityLevelSchema,
    count: Type.Integer({ minimum: 1 }),
    examples: Type.Array(Type.String({ maxLength: 2048 })),
  },
  { additionalProperties: false },
);
