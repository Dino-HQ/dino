// packages/core/src/types/dcg/parse.ts
import { Value, type TParseOperation } from '@sinclair/typebox/value';
import { DcgV1Schema, type DcgV1 } from './v1';

/**
 * Strict pipeline — Clone, Clean, and Convert all removed.
 *   - Assert: validates against schema; throws on any violation INCLUDING unknown properties
 *   - Decode: runs any Codec decoders (none in v1, reserved for future)
 *
 * Why Clone is gone: TypeBox's Clone strips `__proto__` (and other prototype-pollution-class
 * own-properties) silently as a defensive measure. That stripping happens BEFORE Assert,
 * so Assert never sees the malicious key — false-output bug, identical class to the
 * Clean-before-Assert bug. Assert does not mutate input, so Clone is unnecessary anyway.
 *
 * DO NOT USE Value.Parse(DcgV1Schema, input) DIRECTLY. The default pipeline includes
 * both Clone and Clean which strip unknown/prototype-pollution properties silently,
 * violating the additionalProperties: false contract. See Security Surface section of
 * the DCG v1.0 handover spec.
 */
const STRICT_PIPELINE: TParseOperation[] = ['Assert', 'Decode'];

const HTTP_STATUS_KEY = /^[1-5]\d{2}$/;

function validateResponseSchemaKeys(doc: DcgV1): void {
  if (doc.operations === undefined) return;
  for (const [opKey, op] of Object.entries(doc.operations)) {
    if (op.response_schemas === undefined) continue;
    for (const code of Object.keys(op.response_schemas)) {
      if (!HTTP_STATUS_KEY.test(code)) {
        throw new Error(`Invalid response_schemas key "${code}" on operation "${opKey}"`);
      }
    }
  }
}

/**
 * Sanctioned runtime validation entry point for DCG v1-0-0, v1-0-1, and v1-0-2.
 *
 * @param input - Untrusted JSON-decoded value (never access fields before parsing).
 * @returns Parsed, typed DCG document.
 * @throws AssertError when validation fails (unknown fields, wrong literals, etc.).
 */
export function parseDcgV1(input: unknown): DcgV1 {
  // operations-overload returns unknown; one cast at the boundary.
  const parsed = Value.Parse(STRICT_PIPELINE, DcgV1Schema, input) as DcgV1;
  validateResponseSchemaKeys(parsed);
  return parsed;
}
