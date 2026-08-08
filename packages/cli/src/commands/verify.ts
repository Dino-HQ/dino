/**
 * `dino verify` — fetch DCG + Sigstore bundle from Dino Cloud and verify offline (#1154).
 *
 * Trust model: issuer hint comes from the API (`expectedIssuer`), never from argv (INV-5).
 */

import { verifyAttestation, type AttestationBundle } from '@dino/engine';
import { CliError } from '../shared/errors';

/** GitHub Actions OIDC issuer - canonical default for Dino-hosted runners. */
const DINO_DEFAULT_CERTIFICATE_ISSUER = 'https://token.actions.githubusercontent.com';

/** Narrow unknown CLI flag values to non-empty strings (literal keys only - avoids object-injection noise). */
function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function verifyScanIdFrom(flags: Record<string, unknown>): string | undefined {
  return (
    optionalNonEmptyString(flags['_1']) ??
    optionalNonEmptyString(flags['scanId']) ??
    optionalNonEmptyString(flags['scan-id'])
  );
}

type VerifyAuthHeaders = { Authorization: string };

type LoadedAttestation =
  | { kind: 'missing' }
  | { kind: 'none' }
  | { kind: 'http_error'; status: number }
  | { kind: 'ok'; bundle: AttestationBundle; expectedIssuer?: string | null };

function loadedOk(
  bundle: AttestationBundle,
  expectedIssuer: string | null | undefined,
): Extract<LoadedAttestation, { kind: 'ok' }> {
  if (expectedIssuer === undefined) {
    return { kind: 'ok', bundle };
  }
  return { kind: 'ok', bundle, expectedIssuer };
}

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

  const envelope = (await attestationRes.json()) as {
    attestation: AttestationBundle | null;
    expectedIssuer?: string | null;
  };

  if (!envelope.attestation) return { kind: 'none' };
  return loadedOk(envelope.attestation, envelope.expectedIssuer);
}

function certificateIssuerFromApiHint(expectedIssuer: string | null | undefined): string {
  if (expectedIssuer !== undefined && expectedIssuer !== null && expectedIssuer.length > 0) {
    return expectedIssuer;
  }
  return DINO_DEFAULT_CERTIFICATE_ISSUER;
}

/**
 * Entry point for `dino verify <scanId> --cloud-endpoint <url> --token <tenantJwt>`.
 * Does not load `.dino.yml` tenant context — verification is explicit HTTP + Sigstore only.
 */
export async function runVerify(flags: Record<string, unknown>): Promise<number> {
  const scanId = verifyScanIdFrom(flags);
  if (!scanId) {
    console.error(
      'Usage: dino verify <scan-id> --cloud-endpoint <url> --token <tenant-session-jwt>',
    );
    return 1;
  }

  const cloudEndpoint = optionalNonEmptyString(flags['cloud-endpoint']);
  const token = optionalNonEmptyString(flags['token']);
  if (!cloudEndpoint) {
    throw new CliError('--cloud-endpoint is required for verification');
  }
  if (!token) {
    throw new CliError('--token is required for verification');
  }

  const base = cloudEndpoint.replace(/\/$/, '');
  const headers: VerifyAuthHeaders = { Authorization: `Bearer ${token}` };

  const loaded = await loadAttestationForVerify(base, scanId, headers);
  if (loaded.kind === 'missing') {
    console.info('No attestation found for this scan.');
    return 1;
  }
  if (loaded.kind === 'http_error') {
    throw new CliError(`Failed to fetch attestation: HTTP ${String(loaded.status)}`);
  }
  if (loaded.kind === 'none') {
    console.info('Scan completed without attestation.');
    return 1;
  }

  const dcgRes = await fetch(`${base}/v1/scans/${encodeURIComponent(scanId)}/dcg`, { headers }); // determinism:allowed
  if (!dcgRes.ok) {
    throw new CliError(`Failed to fetch scan result: HTTP ${String(dcgRes.status)}`);
  }
  const resultJson = await dcgRes.text();

  const issuer = certificateIssuerFromApiHint(loaded.expectedIssuer);
  const result = await verifyAttestation(loaded.bundle, resultJson, {
    certificateIssuer: issuer,
  });

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
