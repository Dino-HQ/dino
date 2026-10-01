// packages/core/src/types/dino-result/fingerprint.ts
/**
 * The finding fingerprint (HC-37 `buildFindingFingerprint`, Cleanup V2 task 4a): the cloud's identity
 * algorithm moved here unchanged — SHA-256 hex over the five NUL-joined parts — so the legacy and the
 * canonical ingest paths call one owner. NUL is a valid code point: identity boundaries reject it in
 * field values (the rbac auth state does) or two tuples could join to identical bytes.
 */
import { dinoResultDigest, type SubtleDigest } from './canonical';
import type { DinoResultV1 } from './v1';

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

type Finding = DinoResultV1['findings'][number];

/** A finding's identity key: the target's own key (spec-scope D4a.2), never a fallback or sentinel. */
export function canonicalTargetKey(target: Finding['target']): string {
  if (target.kind === 'operation') return target.operationKey;
  if (target.kind === 'schema-element') return target.elementKey;
  return target.tool;
}

/** The evidence key that keeps non-operation targets and rbac auth states distinct under one target key. */
export function canonicalEvidenceKey(f: Pick<Finding, 'target' | 'authState'>): string {
  const parts: string[] = [];
  if (f.target.kind !== 'operation') parts.push(`target-kind:${f.target.kind}`);
  if (f.authState !== undefined) parts.push(`rbac-auth-state:${f.authState}`);
  return parts.join('|');
}

/** The one fingerprint of a canonical finding: what the cloud stores and what SARIF uploads carry. */
export function dinoFindingFingerprint(
  tenantId: string,
  f: Pick<Finding, 'tool' | 'target' | 'classification' | 'authState'>,
  subtle?: SubtleDigest,
): Promise<string> {
  return buildFindingFingerprint(
    {
      tenantId,
      tool: f.tool,
      operation: canonicalTargetKey(f.target),
      classification: f.classification,
      evidenceKey: canonicalEvidenceKey(f),
    },
    subtle,
  );
}
