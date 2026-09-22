/**
 * The runner's completed-result assembly over the canonical `DinoResult` (Cleanup V2 task 4c): the exact
 * canonical bytes and their digest go on the wire, the minimal DCG is projected from the result (the
 * cloud still requires `dcg` and serves `dcg.json`), cancellation and the completed-tool count are read
 * off the verification records, and the attestation — when an identity exists — signs the same bytes.
 */
import { canonicalDinoResultBytes, dinoResultDigest, partitionTools, type DinoResult, type GraphQLOperation, type RunnerJob, type RunnerResult, type ScanAttestationWire } from '@dino/core';
import { buildSnapshot } from '@dino/engine';

/** A cancelled run: a verification record cut off by cancellation (never inferred from an abort alone). */
export const wasCancelled = (result: DinoResult): boolean =>
  result.verification.tools.some((t) => t.status === 'unavailable' && t.execution === 'cancelled');

/** The minimal DCG the cloud requires beside the canonical result: an unsigned projection of `DinoResult` fields. */
export function runnerDcgOf(result: DinoResult, cliVersion: string): { dcg: '1-1-0'; info: Record<string, string | number> } {
  const { identity, verdict } = result;
  return {
    dcg: '1-1-0',
    info: {
      title: `Scan ${identity.runId}`,
      version: identity.generatedAt.slice(0, 10),
      generated: identity.generatedAt,
      generator: `dino-cli/${cliVersion}`,
      confidence: verdict.completeness,
      confidenceMethod: 'verification-completeness-v1',
    },
  };
}

export type CompletedRunnerResultOpts = {
  assignment: RunnerJob;
  result: DinoResult;
  cliVersion: string;
  rotatedRefreshToken: string | undefined;
  authLost: boolean;
  cancelObserved: boolean;
  schemaSnapshot?: unknown;
  /** Resolved by the caller; `undefined` when no identity or the signer failed (INV-1). */
  attest: (result: DinoResult) => Promise<ScanAttestationWire | undefined>;
};

export async function buildCompletedRunnerResult(opts: CompletedRunnerResultOpts): Promise<RunnerResult> {
  const { assignment, result, cliVersion, rotatedRefreshToken: rotated, authLost, cancelObserved, schemaSnapshot } = opts;
  const withRotated = rotated === undefined ? {} : { rotatedRefreshToken: rotated };
  // Terminal cancel (Spec B INV-4): ONLY when the cloud's cancelRequested flag was actually observed
  // AND a verification record was cut off by the cancellation — never fabricated from an abort alone.
  if (cancelObserved && wasCancelled(result)) {
    return { scanId: assignment.scanId, attemptId: assignment.attemptId, status: 'cancelled', toolsCompletedCount: partitionTools(result.verification.tools).completed.length, ...withRotated };
  }
  if (authLost) {
    return { scanId: assignment.scanId, attemptId: assignment.attemptId, status: 'failed', error: 'auth_lost', failureType: 'auth_lost', ...withRotated };
  }
  const dinoResult = canonicalDinoResultBytes(result);
  const [digest, attestation] = await Promise.all([dinoResultDigest(dinoResult), opts.attest(result)]);
  return {
    scanId: assignment.scanId,
    attemptId: assignment.attemptId,
    status: 'completed',
    dcg: runnerDcgOf(result, cliVersion),
    dinoResult,
    dinoResultDigest: digest,
    ...(attestation === undefined ? {} : { attestation }),
    ...withRotated,
    ...(schemaSnapshot === undefined ? {} : { schemaSnapshot }),
  };
}

/** Build a SchemaSnapshot when GraphQL ops exist; omit for REST-only (#2110). */
export function buildRunnerSchemaSnapshot(opts: {
  graphqlOperations: readonly GraphQLOperation[];
  tenantId: string;
}): unknown | undefined {
  if (opts.graphqlOperations.length === 0) {
    return undefined;
  }
  try {
    return buildSnapshot({
      introspection: opts.graphqlOperations,
      tenantId: opts.tenantId,
      environment: 'cloud',
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        message: 'runner_schema_snapshot_build_failed',
        tenant_id: opts.tenantId,
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
    return undefined;
  }
}
