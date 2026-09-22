/**
 * `dino verify` — fetch a scan's canonical `DinoResult` bytes + Sigstore bundle from Dino Cloud and verify
 * offline (#1154, Cleanup V2 task 4c D4c.5).
 *
 * Trust model (INV-5): the signer policy — issuer AND identity — is pinned by the cloud for the scan's
 * assigned runner and returned as `expected`; it never comes from argv, from the bundle, or from a default.
 * No pinned identity ⇒ `verifiable: false` ⇒ exit 1, never a pass.
 */

import { verifyAttestation, type AttestationBundle, type VerifyOptions } from '@dino/engine';
import { CliError } from '../shared/errors';

/** Narrow unknown CLI flag values to non-empty strings (literal keys only - avoids object-injection noise). */
function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function verifyScanIdFrom(flags: Record<string, unknown>): string | undefined {
  // parseArgs camel-cases flags: `--scan-id` arrives as `scanId`.
  return optionalNonEmptyString(flags['_1']) ?? optionalNonEmptyString(flags.scanId);
}

type VerifyAuthHeaders = { Authorization: string };

/** `GET /v1/scans/:id/attestation`: the bundle and the server-pinned signer policy. */
export type AttestationEnvelope = {
  attestation: AttestationBundle | null;
  expected: { issuer: string; identity: { email: string } | { uri: string } } | null;
  verifiable: boolean;
};

type LoadedAttestation =
  | { kind: 'missing' }
  | { kind: 'none' }
  | { kind: 'not-verifiable' }
  | { kind: 'http_error'; status: number }
  | { kind: 'ok'; bundle: AttestationBundle; policy: NonNullable<AttestationEnvelope['expected']> };

async function loadAttestationForVerify(
  base: string,
  scanId: string,
  headers: VerifyAuthHeaders,
): Promise<LoadedAttestation> {
  const attestationRes = await fetch(`${base}/v1/scans/${encodeURIComponent(scanId)}/attestation`, {
    // determinism:allowed
    headers,
  });
  if (attestationRes.status === 404) return { kind: 'missing' };
  if (!attestationRes.ok) return { kind: 'http_error', status: attestationRes.status };

  const envelope = (await attestationRes.json()) as AttestationEnvelope;
  if (!envelope.attestation) return { kind: 'none' };
  if (!envelope.verifiable || !envelope.expected) return { kind: 'not-verifiable' };
  return { kind: 'ok', bundle: envelope.attestation, policy: envelope.expected };
}

/** The pinned policy, verbatim, as sigstore constraints: both the issuer and the one identity form. */
function pinnedVerifyOptions(policy: NonNullable<AttestationEnvelope['expected']>): VerifyOptions {
  return 'email' in policy.identity
    ? { certificateIssuer: policy.issuer, certificateIdentityEmail: policy.identity.email }
    : { certificateIssuer: policy.issuer, certificateIdentityURI: policy.identity.uri };
}

/** The three required inputs, or a usage error (exit 2). */
function parseVerifyFlags(flags: Record<string, unknown>): { scanId: string; base: string; headers: VerifyAuthHeaders } {
  const scanId = verifyScanIdFrom(flags);
  if (!scanId) {
    throw new CliError(
      'Usage: dino verify <scan-id> --cloud-endpoint <url> --token <tenant-session-jwt>',
      2,
      undefined,
      undefined,
      'usage',
    );
  }

  const cloudEndpoint = optionalNonEmptyString(flags.cloudEndpoint); // parseArgs camel-cases `--cloud-endpoint`
  const token = optionalNonEmptyString(flags['token']);
  if (!cloudEndpoint) {
    throw new CliError(
      '--cloud-endpoint is required for verification',
      2,
      undefined,
      undefined,
      'usage',
    );
  }
  if (!token) {
    throw new CliError('--token is required for verification', 2, undefined, undefined, 'usage');
  }
  return { scanId, base: cloudEndpoint.replace(/\/$/, ''), headers: { Authorization: `Bearer ${token}` } };
}

/**
 * Entry point for `dino verify <scanId> --cloud-endpoint <url> --token <tenantJwt>`.
 * Does not load `.dino.yml` tenant context — verification is explicit HTTP + Sigstore only.
 */
export async function runVerify(flags: Record<string, unknown>): Promise<number> {
  const { scanId, base, headers } = parseVerifyFlags(flags);
  const loaded = await loadAttestationForVerify(base, scanId, headers);
  if (loaded.kind === 'missing') {
    console.info('No attestation found for this scan.');
    return 1;
  }
  if (loaded.kind === 'http_error') {
    throw new CliError(`Failed to fetch attestation: HTTP ${String(loaded.status)}`, 70);
  }
  if (loaded.kind === 'none') {
    console.info('Scan completed without attestation.');
    return 1;
  }
  if (loaded.kind === 'not-verifiable') {
    console.info('attestation not verifiable: no pinned signer identity for this runner');
    return 1;
  }

  // The attestation subject is the exact canonical DinoResult bytes the cloud stores (D4c.5).
  const resultRes = await fetch(`${base}/v1/scans/${encodeURIComponent(scanId)}/result`, { headers }); // determinism:allowed
  if (!resultRes.ok) {
    throw new CliError(`Failed to fetch scan result: HTTP ${String(resultRes.status)}`, 70);
  }
  const resultJson = await resultRes.text();

  const result = await verifyAttestation(loaded.bundle, resultJson, pinnedVerifyOptions(loaded.policy));

  if (result.verified) {
    console.info('Scan result is cryptographically verified.');
    console.info(`  Signed at: ${result.signedAt ?? loaded.bundle.signedAt}`);
    if (result.signerIdentity) {
      console.info(`  Signer: ${result.signerIdentity}`);
    }
    console.info(`  Digest: ${loaded.bundle.resultDigest}`);
    return 0;
  }

  console.info(`Verification failed: ${result.error ?? 'unknown error'}`);
  return 1;
}
