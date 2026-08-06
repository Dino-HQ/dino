/**
 * SSRF-guarded OpenAPI spec fetch → local temp file for REST discovery (#2087).
 * Uses the injected pinned fetchImpl — never bare fetch / never dereference(url).
 * INV-1: rest+specUrl fetch/write failure THROWS (never silent GraphQL/empty fallback).
 * INV-4 (#2115): rest+specBody writes locally — fetchImpl is never invoked.
 */

import { unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerJob } from '@dino/core';

export interface RunnerRestSpecLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface RunnerRestSpecDeps {
  /** The pinned fetch (createPinnedFetch); throws SsrfBlockedError on blocked targets. */
  fetchImpl: typeof fetch;
  /** Default os.tmpdir(). */
  tmpDir?: string;
  writeFile?: (p: string, data: Uint8Array) => Promise<void>;
  unlink?: (p: string) => Promise<void>;
  /** Structured events: runner.rest_spec_fetched / runner.rest_spec_failed (never the URL body). */
  logger?: RunnerRestSpecLogger;
}

export interface RunnerRestSpecResult {
  /** Present only for rest+specUrl after a successful fetch+write. */
  restConfig?: { source: string; specPath: string };
  /** Unlink the temp file (no-op if none written). */
  cleanup: () => Promise<void>;
}

function pickSpecExtension(specUrl: string, contentType: string | null): 'yaml' | 'json' {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('yaml') || ct.includes('+yaml')) return 'yaml';
  const pathPart = (specUrl.split(/[?#]/, 1)[0] ?? '').toLowerCase();
  if (pathPart.endsWith('.yaml') || pathPart.endsWith('.yml')) return 'yaml';
  return 'json';
}

const noopCleanup = async (): Promise<void> => undefined;

function sanitizeScanIdForPath(scanId: string): string {
  return scanId.replaceAll(/[^A-Za-z0-9_-]/g, '_');
}

function makeTempCleanup(
  unlink: (p: string) => Promise<void>,
  tempPath: string,
): () => Promise<void> {
  return async () => {
    await unlink(tempPath).catch(() => undefined);
  };
}

async function writeRestSpecTempFile(
  deps: RunnerRestSpecDeps,
  opts: {
    scanId: RunnerJob['scanId'];
    ext: 'json' | 'yaml';
    body: Uint8Array;
    source: 'upload' | 'url';
  },
): Promise<RunnerRestSpecResult> {
  const writeFile = deps.writeFile ?? fsWriteFile;
  const unlink = deps.unlink ?? fsUnlink;
  const baseTmp = deps.tmpDir ?? tmpdir();
  const log = deps.logger;
  const safeScanId = sanitizeScanIdForPath(opts.scanId);
  const tempPath = join(baseTmp, `dino-spec-${safeScanId}.${opts.ext}`);
  try {
    await writeFile(tempPath, opts.body);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.error('runner.rest_spec_failed', { scanId: opts.scanId, reason });
    throw err;
  }
  log?.info('runner.rest_spec_fetched', {
    scanId: opts.scanId,
    bytes: opts.body.byteLength,
    source: opts.source,
  });
  return {
    restConfig: { source: 'openapi', specPath: tempPath },
    cleanup: makeTempCleanup(unlink, tempPath),
  };
}

async function resolveUploadedRunnerRestSpec(
  assignment: Pick<RunnerJob, 'specBody' | 'specFormat' | 'scanId'>,
  deps: RunnerRestSpecDeps,
): Promise<RunnerRestSpecResult> {
  const trimmedBody = assignment.specBody?.trim();
  if (trimmedBody === undefined || trimmedBody === '') {
    return { cleanup: noopCleanup };
  }
  const ext = assignment.specFormat ?? 'json';
  return writeRestSpecTempFile(deps, {
    scanId: assignment.scanId,
    ext,
    body: new TextEncoder().encode(trimmedBody),
    source: 'upload',
  });
}

async function resolveUrlRunnerRestSpec(
  assignment: Pick<RunnerJob, 'specUrl' | 'scanId'>,
  deps: RunnerRestSpecDeps,
): Promise<RunnerRestSpecResult> {
  const trimmedUrl = assignment.specUrl?.trim();
  if (trimmedUrl === undefined || trimmedUrl === '') {
    return { cleanup: noopCleanup };
  }
  const log = deps.logger;
  let res: Response;
  try {
    res = await deps.fetchImpl(trimmedUrl);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.error('runner.rest_spec_failed', { scanId: assignment.scanId, reason });
    throw err;
  }
  if (!res.ok) {
    const reason = `HTTP ${String(res.status)}`;
    log?.error('runner.rest_spec_failed', { scanId: assignment.scanId, reason });
    throw new Error(`rest_spec_fetch_failed: ${reason}`);
  }
  const body = new Uint8Array(await res.arrayBuffer());
  const ext = pickSpecExtension(trimmedUrl, res.headers.get('content-type'));
  return writeRestSpecTempFile(deps, {
    scanId: assignment.scanId,
    ext,
    body,
    source: 'url',
  });
}

/**
 * Resolve a runner REST config from the assignment: fetch the OpenAPI spec via the PINNED fetchImpl
 * (SSRF-safe, DNS-pinned, 16 MiB cap), write it to a temp file, return the local specPath + a cleanup.
 * INV-1: a rest+specUrl scan whose fetch fails THROWS (never a silent GraphQL/empty fallback).
 * Non-rest OR rest-without-specUrl → { restConfig: undefined } (caller keeps the GraphQL path).
 */
export async function resolveRunnerRestSpec(
  assignment: Pick<RunnerJob, 'protocol' | 'specUrl' | 'specBody' | 'specFormat' | 'scanId'>,
  deps: RunnerRestSpecDeps,
): Promise<RunnerRestSpecResult> {
  if (assignment.protocol !== 'rest') {
    return { cleanup: noopCleanup };
  }
  const uploaded = await resolveUploadedRunnerRestSpec(assignment, deps);
  if (uploaded.restConfig !== undefined) {
    return uploaded;
  }
  return resolveUrlRunnerRestSpec(assignment, deps);
}
