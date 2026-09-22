import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const DcgConfidenceSchema = Type.Number({ minimum: 0, maximum: 1 });

/** Shared semantic contract; full and runner DCGs retain distinct metadata shapes. */
export const DcgConfidenceContractSchema = Type.Union([
  Type.Object({
    dcg: Type.Union([Type.Literal("1-0-0"), Type.Literal("1-0-1"), Type.Literal("1-0-2")]),
    info: Type.Object({
      confidence: DcgConfidenceSchema,
      confidenceMethod: Type.Optional(Type.Never()),
    }),
  }),
  Type.Object({
    dcg: Type.Literal("1-1-0"),
    info: Type.Object({
      confidence: DcgConfidenceSchema,
      confidenceMethod: Type.Literal("verification-completeness-v1"),
    }),
  }),
]);

/** Reject invalid producer inputs, never clamp or manufacture confidence. */
export function assertDcgConfidence(value: number): void {
  Value.Assert(DcgConfidenceSchema, value);
}
