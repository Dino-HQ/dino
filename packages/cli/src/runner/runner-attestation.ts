/**
 * Runner-side attestation of the canonical `DinoResult` bytes (Cleanup V2 task 4c, D4c.5).
 *
 * The signer is Sigstore keyless: GitHub Actions supplies an ambient OIDC identity; a Dino-managed
 * runner on GCP mints an ID token from the metadata server. Neither ⇒ no attestation, one log line,
 * the report still ships (INV-1). The runner never tells the cloud who it is — the cloud pins the
 * expected issuer and signer identity from the admitted runner (server-side trust policy).
 */
import { canonicalDinoResultBytes, dinoResultDigest, type DinoResult, type ScanAttestationWire } from '@dino/core';
import { createSigstoreSigner, type AttestationSigner, type Clock } from '@dino/engine';

const GCP_METADATA_HOST = 'metadata.google.internal';
const GCP_IDENTITY_URL = `http://${GCP_METADATA_HOST}/computeMetadata/v1/instance/service-accounts/default/identity?audience=sigstore`;
const GCP_METADATA_TIMEOUT_MS = 2_000;

export type AttestationIdentity = { readonly source: 'github-actions' } | { readonly source: 'gcp'; readonly identityToken: string };

/** GitHub Actions ambient OIDC first; else a GCP metadata ID token; else null (no attestation). */
export async function resolveAttestationIdentity(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<AttestationIdentity | null> {
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL !== undefined && env.ACTIONS_ID_TOKEN_REQUEST_URL !== '') return { source: 'github-actions' };
  try {
    const res = await fetchImpl(GCP_IDENTITY_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(GCP_METADATA_TIMEOUT_MS) });
    if (!res.ok) return null;
    const identityToken = (await res.text()).trim();
    return identityToken === '' ? null : { source: 'gcp', identityToken };
  } catch (e) {
    // Not on GCP (or the metadata server is unreachable): a documented outcome, not an error — unsigned results.
    console.info(JSON.stringify({ message: 'runner_attestation_identity_probe_failed', detail: e instanceof Error ? e.name : String(e) }));
    return null;
  }
}

export function signerForIdentity(identity: AttestationIdentity, clock: Clock): AttestationSigner {
  return createSigstoreSigner(clock, identity.source === 'gcp' ? { identityToken: identity.identityToken } : {});
}

/** The runner's signer for this process: resolved once at start, logged once; `null` = unsigned results. */
export async function resolveRunnerAttestationSigner(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
  clock: Clock,
): Promise<AttestationSigner | null> {
  const identity = await resolveAttestationIdentity(env, fetchImpl);
  console.info(JSON.stringify({ message: 'runner_attestation_identity', source: identity?.source ?? 'none' }));
  return identity === null ? null : signerForIdentity(identity, clock);
}

export type AttestCanonicalResultOpts = {
  result: DinoResult;
  scanId: string;
  agentVersion: string;
  signer: AttestationSigner;
};

/**
 * Sign the exact canonical bytes. The predicate is copied from the result: `startTime` is the scope
 * snapshots' `capturedAt` (the pipeline-start instant, task 3), `endTime` is `identity.generatedAt`,
 * `tools` are the selected verification records, `configHash` digests the canonical bytes of
 * `{ tenantId, targets, tools }`. Returns `undefined` (logged) when the result carries no snapshot or
 * the signer fails — never a fabricated attestation.
 */
export async function attestCanonicalResult(opts: AttestCanonicalResultOpts): Promise<ScanAttestationWire | undefined> {
  const { result, scanId, agentVersion, signer } = opts;
  const startTime = result.scope.snapshots[0]?.capturedAt;
  if (startTime === undefined) {
    console.warn(JSON.stringify({ message: 'runner_attestation_skipped_no_snapshot', scan_id: scanId }));
    return undefined;
  }
  const tools = result.verification.tools.filter((t) => t.status !== 'not-selected').map((t) => t.tool);
  const resultJson = canonicalDinoResultBytes(result);
  try {
    const [resultDigest, configHash] = await Promise.all([
      dinoResultDigest(resultJson),
      dinoResultDigest(canonicalDinoResultBytes({ tenantId: result.identity.tenantId, targets: result.identity.targets, tools })),
    ]);
    return await signer.sign({
      resultJson,
      predicate: { scanId, tenantId: result.identity.tenantId, agentVersion, configHash, startTime, endTime: result.identity.generatedAt, resultDigest, tools },
    });
  } catch (e) {
    console.warn(JSON.stringify({ message: 'runner_attestation_failed', scan_id: scanId, detail: e instanceof Error ? e.message : String(e) }));
    return undefined;
  }
}
