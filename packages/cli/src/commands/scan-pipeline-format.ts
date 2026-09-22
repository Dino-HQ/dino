// @internal - extracted from scan-pipeline.ts for max-lines compliance.
import { canonicalDinoResultBytes, type DinoResult, type ResolvedScanConfig } from '@dino/core';
import { renderScanResultMarkdown } from '../formatters/scan-result-markdown';

const SCAN_REPORT_TITLE = 'API Quality Report';

/** #202: discovery fidelity threaded into the durable scan report */
export type ScanIntrospectionLevel = 'full' | 'shallow' | 'minimal';

/**
 * The scan output for a format (Cleanup V2 task 4c): `json` is the exact canonical `DinoResult` bytes
 * (digest-stable — the same bytes the runner posts and the attestation signs), `markdown` is the
 * host-side rendering of the same result.
 */
export function formatScanResultForOutput(result: DinoResult, format: ResolvedScanConfig['format']): string {
  if (format === 'json') return canonicalDinoResultBytes(result);
  return renderScanResultMarkdown(result, { title: SCAN_REPORT_TITLE });
}

export { SCAN_REPORT_TITLE };
