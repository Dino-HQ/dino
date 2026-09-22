/**
 * Host-side markdown view of a canonical `DinoResult` (Cleanup V2 task 4c): every number is read off
 * the result, never recomputed. Customer-controlled strings (operation keys, examples, reasons) pass
 * through `neutralize` before they reach the document.
 */
import { describeToolLedgerEntry } from '@dino/engine';
import { neutralize } from '../shared/neutralize';
import type { DinoResult } from '@dino/core';

export interface ScanResultMarkdownOptions {
  title: string;
}

type ToolRecord = DinoResult['verification']['tools'][number];
type Operation = DinoResult['operations'][number];
type Finding = DinoResult['findings'][number];

const md = (s: string): string => neutralize(s, 'markdown');
const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

function verdictLines(result: DinoResult, opts: ScanResultMarkdownOptions): string[] {
  const { verdict, scope, identity } = result;
  const score = verdict.health.score === null ? '' : ` (${verdict.health.score}/100)`;
  const operations = verdict.operationCount === null ? 'unknown (scope UNKNOWN)' : String(verdict.operationCount);
  const sources = scope.snapshots.map((s) => s.source).join(', ');
  const structure = sources === '' ? '' : ` (sources: ${sources})`;
  const lines = [
    `# ${opts.title}`,
    '',
    `- **Health:** ${verdict.health.verdict}${score}`,
    `- **Coverage:** ${verdict.coverage} (completeness ${pct(verdict.completeness)})`,
    `- **Operations:** ${operations}`,
    `- **Scope:** ${scope.scopeState}${structure}`,
    `- **Run:** ${md(identity.runId)} · ${md(identity.environment)} · ${identity.generatedAt}`,
  ];
  if (verdict.reasons.length > 0) lines.push(`- **Verdict reasons:** ${verdict.reasons.join(', ')}`);
  return lines;
}

function noticeLines(result: DinoResult): string[] {
  const { verdict, verification } = result;
  const lines: string[] = [];
  if (verification.targetUnreachable) lines.push('', '> Target unreachable: no verification traffic reached the API.');
  if (verdict.degraded) lines.push('', '> Degraded: all agents failed. No test data was produced for this run.');
  else if (verdict.incomplete) lines.push('', '> Incomplete: applicable planned work was not adjudicated (see Tool Coverage).');
  return lines;
}

function scopeGapLines(result: DinoResult): string[] {
  if (result.scope.gaps.length === 0) return [];
  const lines = ['', '## Scope gaps', ''];
  for (const gap of result.scope.gaps) {
    const tool = gap.tool === undefined ? '' : ` (${gap.tool})`;
    const source = gap.source === undefined ? '' : ` [${gap.source}]`;
    lines.push(`- ${gap.reason}${tool}${source}`);
  }
  return lines;
}

function toolLine(t: ToolRecord): string {
  const entry = describeToolLedgerEntry(t.status === 'not-selected' ? { tool: t.tool, status: 'excluded' } : { tool: t.tool, status: t.status, ...('reason' in t ? { reason: t.reason } : {}) });
  if (t.status === 'ran') {
    const { passed, failed, notTested } = t.ledger;
    return `| ${t.tool} | ran | ${passed} passed, ${failed} failed, ${notTested} not tested |`;
  }
  if (t.status === 'not-selected') return `| ${t.tool} | not selected | n/a |`;
  const fix = entry.remediation === undefined ? '' : ` Fix: ${entry.remediation}`;
  return `| ${t.tool} | ${t.status} | ${entry.message}.${fix} |`;
}

function operationLine(op: Operation): string {
  const health = op.healthScore === null ? 'n/a' : String(op.healthScore);
  const deprecated = op.deprecated === true ? ' (deprecated)' : '';
  return `| ${md(op.operationKey)}${deprecated} | ${op.protocol} | ${op.worstSeverity} | ${health} | ${op.executionCoverage} |`;
}

function targetOf(f: Finding): string {
  if (f.target.kind === 'operation') return md(f.target.operationKey);
  if (f.target.kind === 'schema-element') return `schema element ${md(f.target.elementKey)}`;
  return `run (${f.target.tool})`;
}

function findingLine(f: Finding): string {
  const auth = f.authState === undefined ? '' : ` · auth ${md(f.authState)}`;
  const example = f.examples[0] === undefined ? '' : `: ${md(f.examples[0])}`;
  return `- **${f.normalizedLevel}** ${f.tool} · ${targetOf(f)} · ${md(f.classification)} ×${f.count}${auth}${example}`;
}

export function renderScanResultMarkdown(result: DinoResult, opts: ScanResultMarkdownOptions): string {
  const lines = [...verdictLines(result, opts), ...noticeLines(result), ...scopeGapLines(result)];
  lines.push('', '## Tool Coverage', '', '| Tool | Status | Detail |', '|---|---|---|');
  for (const t of result.verification.tools) lines.push(toolLine(t));
  lines.push('', '## Operations', '');
  if (result.operations.length === 0) {
    lines.push('_No operations in scope._');
  } else {
    lines.push('| Operation | Protocol | Severity | Health | Coverage |', '|---|---|---|---|---|');
    for (const op of result.operations) lines.push(operationLine(op));
  }
  lines.push('', '## Findings', '');
  if (result.findings.length === 0) lines.push('_No findings._');
  for (const f of result.findings) lines.push(findingLine(f));
  return `${lines.join('\n')}\n`;
}
