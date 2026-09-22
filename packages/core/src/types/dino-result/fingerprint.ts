// packages/core/src/types/dino-result/fingerprint.ts
/**
 * The finding fingerprint (HC-37 `buildFindingFingerprint`, Cleanup V2 task 4a): the cloud's identity
 * algorithm moved here unchanged — SHA-256 hex over the five NUL-joined parts — so the legacy and the
 * canonical ingest paths call one owner. NUL is a valid code point: identity boundaries reject it in
 * field values (the rbac auth state does) or two tuples could join to identical bytes.
 */
import { dinoResultDigest, type SubtleDigest } from './canonical';

export interface FindingFingerprintInput {
  tenantId: string;
  tool: string;
  /** The target's own key: operation key, schema-element key, or the tool name for a run-level finding. */
  operation: string;
  classification: string;
  /** `''` when the finding carries no evidence key (`''` and absent hash identically, spec §11). */
  evidenceKey: string;
}

export function buildFindingFingerprint(input: FindingFingerprintInput, subtle?: SubtleDigest): Promise<string> {
  const parts = [input.tenantId, input.tool, input.operation, input.classification, input.evidenceKey];
  return dinoResultDigest(parts.join('\u0000'), subtle);
}
