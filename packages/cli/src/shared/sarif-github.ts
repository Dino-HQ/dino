/**
 * GitHub IO for SARIF state reconciliation, inside GitHub Actions only. Reads, never writes: the previous
 * Dino analysis for the exact ref and category, GitHub's download of it, and the state artifact named by
 * its run token. Requests go only to `GITHUB_API_URL` (set by the runner), carry the workflow token, and a
 * failure is returned as a reason: the caller withholds the SARIF rather than guess.
 */
import { inflateRawSync } from 'node:zlib';
import { isStatefulRunSegment, parseSarifState, splitAutomationId, type SarifPrevious } from '@dino/core';

export interface GithubActionsContext {
  apiUrl: string;
  repository: string;
  ref: string;
  sha: string;
  token: string;
}

export type GithubContextResult = { kind: 'actions'; ctx: GithubActionsContext } | { kind: 'local' } | { kind: 'misconfigured'; reason: string };

export function githubContextFromEnv(env: NodeJS.ProcessEnv): GithubContextResult {
  if (env.GITHUB_ACTIONS !== 'true') return { kind: 'local' };
  const { GITHUB_REPOSITORY: repository, GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_API_URL: apiUrl } = env;
  if (repository === undefined || ref === undefined || sha === undefined || apiUrl === undefined) {
    return { kind: 'misconfigured', reason: 'GITHUB_REPOSITORY, GITHUB_REF, GITHUB_SHA and GITHUB_API_URL must be set (the Actions runner sets them)' };
  }
  const token = env.DINO_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  if (token === undefined || token === '') {
    return { kind: 'misconfigured', reason: 'set GITHUB_TOKEN (env: GITHUB_TOKEN: ${{ github.token }}) so Dino can read the previous analysis' };
  }
  return { kind: 'actions', ctx: { apiUrl: apiUrl.replace(/\/+$/, ''), repository, ref, sha, token } };
}

export type Fetch = typeof fetch;
const TIMEOUT_MS = 20_000;
const MAX_SARIF_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const PAGE = 100;

class GithubReadError extends Error {}

async function api(ctx: GithubActionsContext, path: string, f: Fetch, accept = 'application/vnd.github+json'): Promise<Response> {
  const res = await f(`${ctx.apiUrl}/repos/${ctx.repository}${path}`, {
    headers: { Authorization: `Bearer ${ctx.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dino-cli' },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

async function bodyText(res: Response, limit: number): Promise<string> {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > limit) throw new GithubReadError(`response larger than ${limit} bytes`);
  return new TextDecoder().decode(buf);
}

interface Analysis {
  id: number;
  ref: string;
  commit_sha: string;
  category: string;
}

/** The newest Dino analysis for this exact ref and category; `null` when none; throws when that cannot be told. */
async function latestAnalysis(ctx: GithubActionsContext, category: string, f: Fetch): Promise<Analysis | null> {
  const query = new URLSearchParams({ tool_name: 'Dino', ref: ctx.ref, per_page: String(PAGE), sort: 'created', direction: 'desc' });
  const res = await api(ctx, `/code-scanning/analyses?${query.toString()}`, f);
  if (res.status === 404) {
    // GitHub answers 404 "no analysis found" for a repository with no analyses yet; anything else is unknown.
    const text = await bodyText(res, 64 * 1024);
    if (/no analysis found/i.test(text)) return null;
    throw new GithubReadError('listing analyses returned 404');
  }
  if (!res.ok) throw new GithubReadError(`listing analyses returned ${res.status}`);
  const list = JSON.parse(await bodyText(res, MAX_SARIF_BYTES)) as Analysis[];
  if (!Array.isArray(list)) throw new GithubReadError('listing analyses returned no list');
  const match = list.find((a) => a.category === category && a.ref === ctx.ref);
  if (match !== undefined) return match;
  if (list.length >= PAGE) throw new GithubReadError(`no ${category} analysis among the newest ${PAGE} for ${ctx.ref}; older history is not searched`);
  return null;
}

/** Exactly one file from a zip (upload-artifact's archive): stored or deflated entries only. */
export function singleFileFromZip(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number): number => view.getUint16(at, true);
  const u32 = (at: number): number => view.getUint32(at, true);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new GithubReadError('the state artifact is not a zip');
  const files: Array<{ method: number; size: number; offset: number }> = [];
  let p = u32(eocd + 16);
  for (let i = 0; i < u16(eocd + 10); i++) {
    if (u32(p) !== 0x02014b50) throw new GithubReadError('the state artifact zip is malformed');
    const nameLen = u16(p + 28);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (!name.endsWith('/')) files.push({ method: u16(p + 10), size: u32(p + 20), offset: u32(p + 42) });
    p += 46 + nameLen + u16(p + 30) + u16(p + 32);
  }
  const only = files[0];
  if (files.length !== 1 || only === undefined) throw new GithubReadError(`the state artifact holds ${files.length} files, not one`);
  const start = only.offset + 30 + u16(only.offset + 26) + u16(only.offset + 28);
  const data = zip.subarray(start, start + only.size);
  if (only.method === 0) return data;
  if (only.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ZIP_BYTES });
  throw new GithubReadError(`the state artifact uses zip method ${only.method}`);
}

interface Artifact {
  id: number;
  expired: boolean;
  archive_download_url: string;
  workflow_run?: { head_sha?: string } | null;
}

async function artifactText(ctx: GithubActionsContext, a: Artifact, f: Fetch): Promise<string> {
  const res = await api(ctx, `/actions/artifacts/${a.id}/zip`, f);
  const location = res.headers.get('location');
  if (res.status !== 302 || location === null) throw new GithubReadError(`downloading the state artifact returned ${res.status}`);
  // The archive is served from a short-lived signed URL: the workflow token is never sent there.
  const zip = await f(location, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!zip.ok) throw new GithubReadError(`downloading the state archive returned ${zip.status}`);
  const buf = new Uint8Array(await zip.arrayBuffer());
  if (buf.byteLength > MAX_ZIP_BYTES) throw new GithubReadError('the state archive is too large');
  return new TextDecoder().decode(singleFileFromZip(buf));
}

/** The state artifact the analysis names; `undefined` with a reason unless exactly one valid candidate exists. */
async function stateFor(ctx: GithubActionsContext, analysis: Analysis, runToken: string, f: Fetch): Promise<{ text: string } | { missing: string }> {
  const name = `dino-sarif-state-${runToken}`;
  const res = await api(ctx, `/actions/artifacts?${new URLSearchParams({ name, per_page: String(PAGE) }).toString()}`, f);
  if (!res.ok) return { missing: `listing artifacts returned ${res.status}` };
  const { artifacts } = JSON.parse(await bodyText(res, MAX_SARIF_BYTES)) as { artifacts?: Artifact[] };
  // On pull_request events the analysis commit is the merge commit, not the run's head: the state's own binding decides there.
  const isPullRequest = ctx.ref.startsWith('refs/pull/');
  const candidates = (artifacts ?? []).filter((a) => !a.expired && (isPullRequest || a.workflow_run?.head_sha === analysis.commit_sha));
  const valid: string[] = [];
  for (const a of candidates) {
    const text = await artifactText(ctx, a, f);
    const parsed = parseSarifState(text);
    if (parsed.ok && parsed.state.runToken === runToken && parsed.state.commitSha === analysis.commit_sha) valid.push(text);
  }
  const [only] = valid;
  if (valid.length === 1 && only !== undefined) return { text: only };
  if (valid.length > 1) return { missing: `${valid.length} artifacts ${name} match` };
  return { missing: candidates.length === 0 ? `no unexpired artifact ${name} for this analysis` : `artifact ${name} does not hold the state of this analysis` };
}

export type PreviousRead = { ok: true; previous: SarifPrevious; analysisId: number | null } | { ok: false; reason: string };

/** Everything reconciliation needs about the previous analysis, or why it could not be read. */
export async function readPreviousSarif(ctx: GithubActionsContext, category: string, f: Fetch = fetch): Promise<PreviousRead> {
  try {
    const analysis = await latestAnalysis(ctx, category, f);
    if (analysis === null) return { ok: true, previous: { kind: 'none' }, analysisId: null };
    const res = await api(ctx, `/code-scanning/analyses/${analysis.id}`, f, 'application/sarif+json');
    if (!res.ok) return { ok: false, reason: `downloading the previous analysis returned ${res.status}` };
    const sarif = JSON.parse(await bodyText(res, MAX_SARIF_BYTES)) as { runs?: Array<{ automationDetails?: { id?: string } }> };
    const runSegment = splitAutomationId(sarif.runs?.[0]?.automationDetails?.id ?? '').runSegment;
    const state = isStatefulRunSegment(runSegment) ? await stateFor(ctx, analysis, runSegment, f) : { missing: 'the previous analysis was uploaded without Dino state' };
    return {
      ok: true,
      analysisId: analysis.id,
      previous: {
        kind: 'found',
        analysis: { ref: analysis.ref, commitSha: analysis.commit_sha, category: analysis.category, sarif },
        state: 'text' in state ? { kind: 'text', text: state.text } : { kind: 'missing', reason: state.missing },
      },
    };
  } catch (err) {
    // Only our own messages, an HTTP status or a JSON/network error class: never a URL or a header.
    const reason = err instanceof GithubReadError ? err.message : `${err instanceof Error ? err.name : 'error'} while reading GitHub`;
    return { ok: false, reason };
  }
}

/** For the last check before writing: the id of the newest analysis now, or why it could not be read. */
export async function currentAnalysisId(ctx: GithubActionsContext, category: string, f: Fetch = fetch): Promise<{ ok: true; id: number | null } | { ok: false; reason: string }> {
  try {
    return { ok: true, id: (await latestAnalysis(ctx, category, f))?.id ?? null };
  } catch (err) {
    return { ok: false, reason: err instanceof GithubReadError ? err.message : 'GitHub could not be read' };
  }
}
