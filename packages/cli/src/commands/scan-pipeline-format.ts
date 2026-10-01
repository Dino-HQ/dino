// @internal - extracted from scan-pipeline.ts for max-lines compliance.
import { gzipSync } from 'node:zlib';
import { canonicalDinoResultBytes, type DinoResult, renderDinoResultSarif, type ResolvedScanConfig, type SarifLog } from '@dino/core';
import { renderScanResultMarkdown } from '../formatters/scan-result-markdown';
import { CliError } from '../shared/errors';

const SCAN_REPORT_TITLE = 'API Quality Report';

/** #202: discovery fidelity threaded into the durable scan report */
export type ScanIntrospectionLevel = 'full' | 'shallow' | 'minimal';

/**
 * The scan output for a format (Cleanup V2 task 4c): `json` is the exact canonical `DinoResult` bytes
 * (digest-stable — the same bytes the runner posts and the attestation signs), `markdown` is the
 * host-side rendering of the same result.
 */
export function formatScanResultForOutput(result: DinoResult, format: Exclude<ResolvedScanConfig['format'], 'sarif'>): string {
  if (format === 'json') return canonicalDinoResultBytes(result);
  return renderScanResultMarkdown(result, { title: SCAN_REPORT_TITLE });
}

/** GitHub code scanning limits per upload (docs: SARIF support, results-exceed-limit). */
export const SARIF_MAX_RESULTS = 25_000;
export const SARIF_MAX_GZIP_BYTES = 10 * 1024 * 1024;

function tooLargeForCodeScanning(what: string): CliError {
  return new CliError(
    `This result is too large for GitHub code scanning (${what}), so no SARIF was written.`,
    2,
    'Use --format json for the full result; SARIF output is never truncated.',
    undefined,
    'usage',
  );
}

/** The SARIF 2.1.0 document for a result, refused (never truncated) when GitHub would not accept it. */
export async function formatScanResultAsSarif(
  result: DinoResult,
  anchorUri: string,
  modules?: readonly string[] | undefined,
): Promise<string> {
  // Cheap check first: one SARIF result per finding, so an oversized result is refused before rendering it.
  if (result.findings.length > SARIF_MAX_RESULTS) {
    throw tooLargeForCodeScanning(`${result.findings.length} findings, limit ${SARIF_MAX_RESULTS}`);
  }
  return serializeSarifWithinLimits(await renderDinoResultSarif(result, { anchorUri, modules }));
}

/** Stable 2-space JSON, refused (never truncated) over GitHub's per-upload limits. */
export function serializeSarifWithinLimits(log: SarifLog): string {
  const results = log.runs[0]?.results.length ?? 0;
  if (results > SARIF_MAX_RESULTS) throw tooLargeForCodeScanning(`${results} results, limit ${SARIF_MAX_RESULTS}`);
  const text = JSON.stringify(log, null, 2);
  const compressed = gzipSync(text).byteLength;
  if (compressed > SARIF_MAX_GZIP_BYTES) throw tooLargeForCodeScanning(`${compressed} bytes compressed, limit ${SARIF_MAX_GZIP_BYTES}`);
  return text;
}

export { SCAN_REPORT_TITLE };
