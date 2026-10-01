/**
 * `dino scan --format sarif` output. Outside GitHub Actions the SARIF is stateless and only a complete run is
 * written. Inside Actions every upload is reconciled with the previous analysis for its exact ref and
 * category (`reconcileSarif`), and the state the next run needs is written to `--sarif-state`. Whenever Dino
 * cannot establish what an upload would close, no SARIF is written and the scan keeps its own exit code.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { reconcileSarif, sarifCategory, sarifUnverifiedReason, sarifWithheldReason, type DinoResult, type SarifLog } from '@dino/core';
import { emitResult } from '../shared/emit-result';
import { CliError } from '../shared/errors';
import { currentAnalysisId, githubContextFromEnv, readPreviousSarif, type Fetch, type GithubActionsContext } from '../shared/sarif-github';
import { formatScanResultAsSarif, serializeSarifWithinLimits } from './scan-pipeline-format';

export type SarifMode = { kind: 'stateless' } | { kind: 'stateful'; ctx: GithubActionsContext; statePath: string; rebaseline: boolean };

const usage = (message: string, hint?: string): CliError => new CliError(message, 2, hint, undefined, 'usage');

/** Decided before any request, so a misconfigured workflow fails fast with exit 2 and no scan traffic. */
export function resolveSarifMode(flags: { sarifState?: string | undefined; sarifRebaseline?: boolean | undefined }, env: NodeJS.ProcessEnv): SarifMode {
  const github = githubContextFromEnv(env);
  if (github.kind === 'local') {
    if (flags.sarifState !== undefined || flags.sarifRebaseline === true) {
      throw usage('--sarif-state and --sarif-rebaseline only work inside GitHub Actions, where Dino can read the previous code scanning analysis.');
    }
    return { kind: 'stateless' };
  }
  if (github.kind === 'misconfigured') throw usage(`--format sarif in GitHub Actions cannot reconcile with code scanning: ${github.reason}.`);
  if (flags.sarifState === undefined) {
    throw usage(
      '--format sarif in GitHub Actions needs --sarif-state <file>.',
      'Dino writes the state the next run needs to reconcile alerts there; upload it as an artifact named dino-sarif-state-<steps.<id>.outputs.sarif-run-token>.',
    );
  }
  return { kind: 'stateful', ctx: github.ctx, statePath: flags.sarifState, rebaseline: flags.sarifRebaseline === true };
}

const notWritten = (why: string): void => {
  console.error(`No SARIF written: ${why}. Existing code scanning alerts are left as they are. Use --format json or markdown to see this run's result.`);
};

export interface EmitScanSarifParams {
  result: DinoResult;
  anchorUri: string;
  modules?: readonly string[] | undefined;
  mode: SarifMode;
  quiet?: boolean | undefined;
  fetchImpl?: Fetch | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function emitScanSarif(p: EmitScanSarifParams): Promise<void> {
  if (p.mode.kind === 'stateless') {
    const withheld = sarifWithheldReason(p.result);
    if (withheld === undefined) emitResult(await formatScanResultAsSarif(p.result, p.anchorUri, p.modules), { format: 'json' });
    else notWritten(`this run is not complete (${withheld}), and uploading it would mark alerts Dino did not test as fixed`);
    return;
  }
  await emitReconciledSarif(p, p.mode);
}

async function emitReconciledSarif(p: EmitScanSarifParams, mode: Extract<SarifMode, { kind: 'stateful' }>): Promise<void> {
  const unverified = sarifUnverifiedReason(p.result);
  if (unverified !== undefined) return notWritten(`this run verified nothing (${unverified})`);
  if (mode.rebaseline && p.result.verdict.incomplete) {
    throw usage('--sarif-rebaseline needs a complete run, and this run is partial. No SARIF was written.', 'Rebaseline with a complete scan; a partial one would close alerts it did not test.');
  }
  const f = p.fetchImpl ?? fetch;
  const category = await sarifCategory(p.result, p.modules ?? []);
  const read = await readPreviousSarif(mode.ctx, category, f);
  if (!read.ok) return notWritten(`the previous code scanning analysis could not be read (${read.reason}), so Dino cannot tell which alerts this upload would close`);

  const out = await reconcileSarif(p.result, {
    anchorUri: p.anchorUri,
    modules: p.modules,
    ref: mode.ctx.ref,
    commitSha: mode.ctx.sha,
    previous: read.previous,
    rebaseline: mode.rebaseline,
  });
  if (out.kind === 'withheld') return notWritten(out.reason);
  const text = serializeSarifWithinLimits(out.log satisfies SarifLog);

  // Defence in depth for the documented per-ref concurrency group: a newer upload means our base is stale.
  const now = await currentAnalysisId(mode.ctx, category, f);
  if (!now.ok || now.id !== read.analysisId) {
    return notWritten(now.ok ? 'another Dino upload for this ref and category landed while this scan ran' : `GitHub could not be re-checked (${now.reason})`);
  }

  writeFileSync(mode.statePath, `${JSON.stringify(out.state)}\n`, 'utf8');
  const outputFile = (p.env ?? process.env).GITHUB_OUTPUT;
  if (outputFile !== undefined && outputFile !== '') appendFileSync(outputFile, `sarif-run-token=${out.state.runToken}\n`, 'utf8');
  emitResult(text, { format: 'json' });
  if (p.quiet !== true) {
    console.error(`SARIF: ${out.mode} upload; ${out.carried} alert(s) carried forward untested, ${out.closed} closed after re-verification.`);
  }
}
