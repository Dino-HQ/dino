// packages/core/src/types/dino-result/parse.ts
import { Value, type TParseOperation } from '@sinclair/typebox/value';
import { canonicalDinoResultBytes, MAX_CANONICAL_BYTES } from './canonical';
import { freezeDeep } from './freeze';
import { assertDinoResultPartitions } from './partitions';
import { DinoResultV1Schema, type DinoResult, type DinoResultV1 } from './v1';

/**
 * Strict pipeline, same reasoning as `types/dcg/parse.ts`: no Clone (strips `__proto__` before
 * Assert), no Clean (strips unknown keys and silently violates `additionalProperties: false`).
 */
const STRICT_PIPELINE: TParseOperation[] = ['Assert', 'Decode'];

/**
 * Sanctioned runtime validation of a `DinoResult` — the same check the constructor runs before
 * freezing and the cloud runs at ingress (spec §12). Schema first, then the partition assertions.
 *
 * @param input - Untrusted JSON-decoded value (never access fields before parsing).
 * @returns The validated result: a detached copy, deeply frozen, so neither the caller's input reference
 *   nor a later mutation can drift from the bytes and digest derived from it (Codex review).
 * @throws AssertError on a schema violation; DinoResultPartitionError on a disagreeing count or ordering.
 */
export class DinoResultSizeError extends Error {
  constructor(bytes: number, cap: number) {
    super(`[dino-result] canonical result is ${bytes} bytes; the cap is ${cap}`);
    this.name = 'DinoResultSizeError';
  }
}

export function parseDinoResultV1(input: unknown, maxCanonicalBytes = MAX_CANONICAL_BYTES): DinoResult {
  // operations-overload returns unknown; one cast at the boundary.
  const parsed = Value.Parse(STRICT_PIPELINE, DinoResultV1Schema, input) as DinoResultV1;
  assertDinoResultPartitions(parsed);
  // The cap is part of the contract (Codex review): a result the producer would refuse is not canonical at ingress either.
  const bytes = new TextEncoder().encode(canonicalDinoResultBytes(parsed)).length;
  if (bytes > maxCanonicalBytes) throw new DinoResultSizeError(bytes, maxCanonicalBytes);
  return freezeDeep(structuredClone(parsed));
}
