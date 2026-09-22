// packages/core/src/types/dino-result/v1-verification.ts
import { Type } from '@sinclair/typebox';
import { VERIFICATION_UNITS } from '../result-envelope';
import {
  LedgerSchema,
  NonNegativeInt,
  ProtocolSchema,
  ToolNameSchema,
  VerificationUnitSchema,
} from './v1-common';

export const ExecutionSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('timeout'),
  Type.Literal('budget-cut'),
  Type.Literal('cancelled'),
  Type.Literal('crashed'),
  /** The consecutive-failure circuit breaker skipped the tool (review C‑11). */
  Type.Literal('skipped'),
  /** A selected tool the run never started (no execution record). */
  Type.Literal('not-run'),
]);

export const ExcludedReasonSchema = Type.Union([
  Type.Literal('not-applicable-protocol'),
  Type.Literal('requires-roles'),
]);

export const UnavailableReasonSchema = Type.Union([
  Type.Literal('reduced-introspection'),
  Type.Literal('tool-failed'),
  Type.Literal('budget-cut'),
  Type.Literal('run-cancelled'),
  Type.Literal('requires-auth'),
  Type.Literal('no-testable-operations'),
  Type.Literal('not-executed'),
  Type.Literal('circuit-breaker'),
]);

/** ONE per-tool record; status and execution provenance never collapse into each other (spec §9.3). */
export const VerificationToolSchema = Type.Union([
  Type.Object(
    { tool: ToolNameSchema, status: Type.Literal('not-selected') },
    { additionalProperties: false },
  ),
  Type.Object(
    { tool: ToolNameSchema, status: Type.Literal('excluded'), reason: ExcludedReasonSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: ToolNameSchema,
      status: Type.Literal('unavailable'),
      reason: UnavailableReasonSchema,
      execution: ExecutionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tool: ToolNameSchema,
      status: Type.Literal('ran'),
      execution: ExecutionSchema,
      /** `null` for a crash envelope (the kernel's crash envelope carries no unit). */
      unit: Type.Union([VerificationUnitSchema, Type.Null()]),
      ledger: LedgerSchema,
      /** Units whose subject is not an API operation (schema elements, run-level); keeps the partition exact. */
      nonOperationUnits: LedgerSchema,
      examinedOperations: NonNegativeInt,
      examinedProtocols: Type.Array(ProtocolSchema),
      targetUnreachable: Type.Boolean(),
      durationMs: NonNegativeInt,
    },
    { additionalProperties: false },
  ),
]);

export const VerificationSchema = Type.Object(
  {
    /** Run-level, owner `computeTargetUnreachable` (review C‑16). */
    targetUnreachable: Type.Boolean(),
    durationMs: NonNegativeInt,
    tools: Type.Array(VerificationToolSchema),
    byUnit: Type.Object(
      Object.fromEntries(VERIFICATION_UNITS.map((u) => [u, Type.Optional(LedgerSchema)])),
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
