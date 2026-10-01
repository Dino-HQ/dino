/**
 * SARIF state reconciliation (I8: nothing untested is ever closed). GitHub marks every alert missing from an
 * upload as fixed, so before an upload replaces a previous analysis, every previous alert is either re-found,
 * proven clean by this run on its exact unit under the same tool plan, or carried forward unchanged. GitHub's
 * downloaded analysis is authoritative for what exists and for each carried payload; Dino's state supplies
 * only what GitHub strips (unit, plan, last verifying run). Anything that cannot be established withholds.
 * Pure: the CLI does the IO and passes the previous analysis and state text in.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { dinoFindingFingerprint } from '../types/dino-result/fingerprint';
import type { DinoResult } from '../types/dino-result/v1';
import {
  buildSarifLog,
  sarifCategory,
  sarifUnverifiedReason,
  sarifWithheldReason,
  type RenderSarifOptions,
  type SarifLevel,
  type SarifLog,
  type SarifResult,
  type SarifRule,
} from './dino-result-sarif';
import {
  isStatefulRunSegment,
  parseSarifState,
  SARIF_STATE_VERSION,
  sarifRunToken,
  sarifUnitOf,
  splitAutomationId,
  type SarifState,
  type SarifStateEntry,
  type SarifUnit,
} from './sarif-state';

export interface SarifPreviousAnalysis {
  /** The exact ref the analysis was looked up by, and the analysis' own `commit_sha` and `category`. */
  ref: string;
  commitSha: string;
  category: string;
  /** GitHub's `application/sarif+json` download: untrusted, parsed here. */
  sarif: unknown;
}

export type SarifPreviousState = { kind: 'text'; text: string } | { kind: 'missing'; reason: string };

export type SarifPrevious = { kind: 'none' } | { kind: 'found'; analysis: SarifPreviousAnalysis; state: SarifPreviousState };

export interface ReconcileSarifOptions extends RenderSarifOptions {
  ref: string;
  commitSha: string;
  previous: SarifPrevious;
  /** `--sarif-rebaseline`: a complete run replaces the previous analysis as is (operator recovery). */
  rebaseline?: boolean | undefined;
}

export type ReconcileSarifOutcome =
  | { kind: 'upload'; mode: 'first' | 'reconciled' | 'baseline' | 'rebaseline'; log: SarifLog; state: SarifState; carried: number; closed: number }
  | { kind: 'withheld'; reason: string };

const Text = Type.Object({ text: Type.String({ maxLength: 65_536 }) });
const DownloadedRule = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 512 }),
  name: Type.Optional(Type.String({ maxLength: 512 })),
  shortDescription: Text,
  fullDescription: Text,
  help: Text,
  properties: Type.Object({
    tags: Type.Array(Type.String({ maxLength: 200 })),
    'security-severity': Type.Optional(Type.String({ maxLength: 16 })),
    'problem.severity': Type.Optional(Type.Union([Type.Literal('error'), Type.Literal('warning'), Type.Literal('recommendation')])),
  }),
});
const DownloadedResult = Type.Object({
  ruleId: Type.String({ minLength: 1, maxLength: 512 }),
  level: Type.Union([Type.Literal('error'), Type.Literal('warning'), Type.Literal('note')]),
  message: Text,
  locations: Type.Array(
    Type.Object({
      physicalLocation: Type.Object({
        artifactLocation: Type.Object({ uri: Type.String({ minLength: 1, maxLength: 1024 }) }),
        region: Type.Object({ startLine: Type.Integer({ minimum: 1 }) }),
      }),
    }),
    { minItems: 1, maxItems: 1 },
  ),
  partialFingerprints: Type.Object({ primaryLocationLineHash: Type.String({ minLength: 1, maxLength: 256 }) }),
});
const DownloadedSarif = Type.Object({
  runs: Type.Array(
    Type.Object({
      automationDetails: Type.Object({ id: Type.String({ minLength: 1, maxLength: 1024 }) }),
      tool: Type.Object({ driver: Type.Object({ rules: Type.Array(DownloadedRule) }) }),
      results: Type.Array(DownloadedResult),
    }),
    { minItems: 1, maxItems: 1 },
  ),
});
type Downloaded = Static<typeof DownloadedSarif>;

const withheld = (reason: string): ReconcileSarifOutcome => ({ kind: 'withheld', reason });

/** A carried result is rebuilt from the fields Dino accepts, so GitHub's own additions never round-trip. */
function carriedResult(r: Downloaded['runs'][number]['results'][number]): SarifResult {
  const loc = r.locations[0];
  return {
    ruleId: r.ruleId,
    level: r.level satisfies SarifLevel,
    message: { text: r.message.text },
    locations: loc === undefined ? [] : [{ physicalLocation: { artifactLocation: { uri: loc.physicalLocation.artifactLocation.uri }, region: { startLine: loc.physicalLocation.region.startLine } } }],
    partialFingerprints: { primaryLocationLineHash: r.partialFingerprints.primaryLocationLineHash },
    properties: {},
  };
}

function carriedRule(r: Downloaded['runs'][number]['tool']['driver']['rules'][number]): SarifRule {
  const p = r.properties;
  return {
    id: r.id,
    name: r.name ?? r.id,
    shortDescription: { text: r.shortDescription.text },
    fullDescription: { text: r.fullDescription.text },
    help: { text: r.help.text },
    properties: {
      tags: [...p.tags],
      ...(p['security-severity'] === undefined ? {} : { 'security-severity': p['security-severity'] }),
      ...(p['problem.severity'] === undefined ? {} : { 'problem.severity': p['problem.severity'] }),
    },
  };
}

/** What GitHub shows for a rule: whether it is a security rule, and how severe. Text may change between versions. */
function severityKey(rule: SarifRule): string {
  const tags = [...rule.properties.tags].sort((a, b) => (a < b ? -1 : Number(a > b)));
  return JSON.stringify([tags.includes('security'), rule.properties['security-severity'] ?? null, rule.properties['problem.severity'] ?? null]);
}

type Op = DinoResult['operations'][number];
type ToolRecord = DinoResult['verification']['tools'][number];

/** An operation row proves its unit clean only when it was planned at a known size, fully adjudicated, and did real work. */
function operationVerified(result: DinoResult, protocol: string, operationKey: string, tool: string): boolean {
  const op: Op | undefined = result.operations.find((o) => o.protocol === protocol && o.operationKey === operationKey);
  const row = op?.tools.find((t) => t.tool === tool);
  if (row === undefined || row.disposition !== 'planned' || row.cardinality !== 'known') return false;
  return row.ledger.notTested === 0 && (row.ledger.passed + row.ledger.failed > 0 || row.findingCount > 0);
}

/** A schema-element or run alert has no per-unit coverage: only a complete run whose tool finished everything may close it. */
function toolFullyVerified(result: DinoResult, tool: string): boolean {
  if (result.verdict.incomplete) return false;
  const record: ToolRecord | undefined = result.verification.tools.find((t) => t.tool === tool);
  return record?.status === 'ran' && record.execution === 'completed' && record.ledger.notTested === 0;
}

/** May a previous alert, not re-found by this run, leave the upload (and so be closed by GitHub)? */
function mayClose(result: DinoResult, entry: SarifStateEntry): boolean {
  const unit: SarifUnit = entry.unit;
  const tool = unit[0] === 'run' ? unit[1] : unit[3];
  const plan = result.provenance.planSnapshots?.[tool];
  if (entry.planSnapshot === null || plan === undefined || entry.planSnapshot !== plan) return false;
  if (unit[0] === 'operation') return operationVerified(result, unit[1], unit[2], unit[3]);
  return toolFullyVerified(result, tool);
}

async function nativeEntries(result: DinoResult): Promise<Record<string, SarifStateEntry>> {
  const entries: Record<string, SarifStateEntry> = {};
  for (const f of result.findings) {
    entries[await dinoFindingFingerprint(result.identity.tenantId, f)] = {
      unit: sarifUnitOf(f),
      planSnapshot: result.provenance.planSnapshots?.[f.tool] ?? null,
      lastVerifiedRunId: result.identity.runId,
    };
  }
  return entries;
}

interface Native {
  log: SarifLog;
  entries: Record<string, SarifStateEntry>;
  category: string;
  runToken: string;
}

function stateOf(result: DinoResult, o: ReconcileSarifOptions, n: Native, entries: Record<string, SarifStateEntry>): SarifState {
  return {
    dinoSarifState: SARIF_STATE_VERSION,
    ref: o.ref,
    category: n.category,
    runId: result.identity.runId,
    runToken: n.runToken,
    commitSha: o.commitSha,
    entries,
  };
}

interface Binding {
  state: SarifState;
  analysis: SarifPreviousAnalysis;
  runSegment: string;
  expectedToken: string;
  category: string;
}

/** Checks the state describes exactly this analysis; returns why not, or undefined. */
function unboundReason(b: Binding): string | undefined {
  if (b.state.ref !== b.analysis.ref) return 'the state belongs to another ref';
  if (b.state.category !== b.analysis.category || b.state.category !== b.category) return 'the state belongs to another category';
  if (b.state.runToken !== b.expectedToken || b.state.runToken !== b.runSegment) return 'the state belongs to another run';
  if (b.state.commitSha !== b.analysis.commitSha) return 'the state belongs to another commit';
  return undefined;
}

interface Carry {
  carried: Array<{ result: SarifResult; ruleId: string }>;
  entries: Record<string, SarifStateEntry>;
  closed: number;
}

/** Every alert GitHub holds is re-found, proven clean on its unit under the same plan, or carried. */
function carryForward(result: DinoResult, native: Native, downloaded: Downloaded['runs'][number], state: SarifState): Carry | string {
  const nativeFps = new Set(native.log.runs[0]?.results.map((r) => r.partialFingerprints.primaryLocationLineHash));
  const out: Carry = { carried: [], entries: { ...native.entries }, closed: 0 };
  for (const r of downloaded.results) {
    const fp = r.partialFingerprints.primaryLocationLineHash;
    const entry = state.entries[fp];
    if (entry === undefined) return 'GitHub holds an alert the Dino state does not describe';
    if (nativeFps.has(fp)) continue;
    if (mayClose(result, entry)) {
      out.closed++;
      continue;
    }
    out.carried.push({ result: carriedResult(r), ruleId: r.ruleId });
    out.entries[fp] = entry;
  }
  return out;
}

/** This run's rules plus each carried alert's rule from GitHub; one rule id can carry only one severity. */
function mergedRules(native: readonly SarifRule[], downloaded: Downloaded['runs'][number], carry: Carry): SarifRule[] | string {
  const rules = new Map(native.map((r) => [r.id, r]));
  const fromGithub = new Map(downloaded.tool.driver.rules.map((r) => [r.id, r]));
  for (const { ruleId } of carry.carried) {
    const source = fromGithub.get(ruleId);
    if (source === undefined) return `GitHub's analysis has no rule ${ruleId}`;
    const rule = carriedRule(source);
    const existing = rules.get(rule.id);
    if (existing === undefined) rules.set(rule.id, rule);
    else if (severityKey(existing) !== severityKey(rule)) return `rule ${rule.id} would need two severities (this run and a carried alert)`;
  }
  return [...rules.values()].sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
}

interface Ctx {
  result: DinoResult;
  options: ReconcileSarifOptions;
  native: Native;
  complete: boolean;
}

function asIs(ctx: Ctx, mode: 'first' | 'baseline' | 'rebaseline'): ReconcileSarifOutcome {
  return { kind: 'upload', mode, log: ctx.native.log, state: stateOf(ctx.result, ctx.options, ctx.native, ctx.native.entries), carried: 0, closed: 0 };
}

function reconcileWithState(ctx: Ctx, downloaded: Downloaded['runs'][number], state: SarifState): ReconcileSarifOutcome {
  const run = ctx.native.log.runs[0];
  if (run === undefined) return withheld('the SARIF has no run');
  const carry = carryForward(ctx.result, ctx.native, downloaded, state);
  if (typeof carry === 'string') return withheld(carry);
  const rules = mergedRules(run.tool.driver.rules, downloaded, carry);
  if (typeof rules === 'string') return withheld(rules);
  const log: SarifLog = {
    ...ctx.native.log,
    runs: [{ ...run, results: [...run.results, ...carry.carried.map((c) => c.result)], tool: { driver: { ...run.tool.driver, rules } } }],
  };
  return { kind: 'upload', mode: 'reconciled', log, state: stateOf(ctx.result, ctx.options, ctx.native, carry.entries), carried: carry.carried.length, closed: carry.closed };
}

/** A previous analysis exists for this exact ref and category. */
async function reconcileFound(ctx: Ctx, analysis: SarifPreviousAnalysis, previousState: SarifPreviousState): Promise<ReconcileSarifOutcome> {
  if (analysis.ref !== ctx.options.ref || analysis.category !== ctx.native.category) return withheld("the previous analysis is not this ref and category's");
  if (ctx.options.rebaseline === true) return ctx.complete ? asIs(ctx, 'rebaseline') : withheld('--sarif-rebaseline needs a complete run');
  if (!Value.Check(DownloadedSarif, analysis.sarif)) return withheld("GitHub's previous analysis is missing fields Dino needs (a fingerprint or the run id)");
  const downloaded = analysis.sarif.runs[0];
  if (downloaded === undefined) return withheld("GitHub's previous analysis has no run");
  const { runSegment } = splitAutomationId(downloaded.automationDetails.id);
  if (!isStatefulRunSegment(runSegment)) {
    return ctx.complete ? asIs(ctx, 'baseline') : withheld('the previous analysis was uploaded without Dino state; one complete run replaces it');
  }
  if (previousState.kind === 'missing') return withheld(`the Dino state for the previous analysis is unavailable (${previousState.reason})`);
  const parsed = parseSarifState(previousState.text);
  if (!parsed.ok) return withheld(parsed.reason);
  const expectedToken = await sarifRunToken(parsed.state.runId, 'stateful');
  const unbound = unboundReason({ state: parsed.state, analysis, runSegment, expectedToken, category: ctx.native.category });
  if (unbound !== undefined) return withheld(unbound);
  return reconcileWithState(ctx, downloaded, parsed.state);
}

export async function reconcileSarif(result: DinoResult, options: ReconcileSarifOptions): Promise<ReconcileSarifOutcome> {
  const unverified = sarifUnverifiedReason(result);
  if (unverified !== undefined) return withheld(unverified);
  const runToken = await sarifRunToken(result.identity.runId, 'stateful');
  const native: Native = {
    log: await buildSarifLog(result, options, runToken),
    entries: await nativeEntries(result),
    category: await sarifCategory(result, options.modules ?? []),
    runToken,
  };
  const ctx: Ctx = { result, options, native, complete: sarifWithheldReason(result) === undefined };
  if (options.previous.kind === 'none') return asIs(ctx, 'first');
  return reconcileFound(ctx, options.previous.analysis, options.previous.state);
}
