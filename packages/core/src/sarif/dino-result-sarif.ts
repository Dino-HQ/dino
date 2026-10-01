/**
 * SARIF 2.1.0 projection of a `DinoResult` for GitHub code scanning (#2177). A projection only: every value
 * comes from the result, nothing is recomputed: a rule's severity is its findings' own `normalizedLevel`.
 * GitHub dedupes alerts on `partialFingerprints.primaryLocationLineHash`, needs a repository file location
 * for every result, and treats an upload as the whole answer for its category — so only a complete run is
 * rendered (`sarifWithheldReason`); anything less would mark untested alerts as fixed.
 */
import { DinoError } from '../errors';
import type { SeverityLevel } from '../types/result-envelope';
import { canonicalDinoResultBytes, dinoResultDigest } from '../types/dino-result/canonical';
import { canonicalTargetKey, dinoFindingFingerprint } from '../types/dino-result/fingerprint';
import type { DinoToolName } from '../types/dino-result/v1-common';
import type { VerdictReason } from '../types/dino-result/v1-verdict';
import type { DinoResult } from '../types/dino-result/v1';
import { sarifRuleText } from './rule-text';
import { sarifRunToken } from './sarif-state';
import { isSecurityClassification } from './security-classifications';

export type SarifLevel = 'error' | 'warning' | 'note';
type ProblemSeverity = 'error' | 'warning' | 'recommendation';

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string };
  properties: {
    tags: string[];
    'security-severity'?: string;
    'problem.severity'?: ProblemSeverity;
  };
}

export interface SarifLogicalLocation {
  name: string;
  fullyQualifiedName?: string;
  kind: string;
}

export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number };
    };
    logicalLocations?: SarifLogicalLocation[];
  }>;
  partialFingerprints: { primaryLocationLineHash: string };
  properties: Record<string, unknown>;
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      semanticVersion: string;
      informationUri: string;
      rules: SarifRule[];
    };
  };
  automationDetails: { id: string };
  invocations: Array<{ executionSuccessful: boolean }>;
  results: SarifResult[];
  properties: { dino: Record<string, unknown> };
}

export interface SarifLog {
  version: '2.1.0';
  runs: SarifRun[];
}

export interface RenderSarifOptions {
  /** A repository-relative path (forward slashes) to a file that exists in the repository. */
  anchorUri: string;
  /**
   * The scan's `--modules` selection. Tool selection is read from the result; together they make the
   * analysis category, so a narrowed scan never supersedes (and closes) a broader scan's alerts.
   */
  modules?: readonly string[] | undefined;
}


const RESULT_LEVEL: Readonly<Record<SeverityLevel, SarifLevel>> = {
  CRITICAL: 'error',
  HIGH: 'error',
  MEDIUM: 'warning',
  LOW: 'note',
  INFO: 'note',
};
const PROBLEM_SEVERITY: Readonly<Record<SeverityLevel, ProblemSeverity>> = {
  CRITICAL: 'error',
  HIGH: 'error',
  MEDIUM: 'warning',
  LOW: 'recommendation',
  INFO: 'recommendation',
};
const SECURITY_SEVERITY: Readonly<Record<SeverityLevel, string>> = {
  CRITICAL: '9.5',
  HIGH: '8.0',
  MEDIUM: '5.5',
  LOW: '2.0',
  INFO: '1.0',
};

const REASON_TEXT: Readonly<Record<VerdictReason, string>> = {
  ALL_TOOLS_FAILED: 'every selected tool failed',
  EMPTY_RUN: 'nothing was tested',
  PARTIAL_TOOL_FAILURE: 'some tools failed',
  PARTIAL_COVERAGE: 'some operations were not tested',
  TARGET_UNREACHABLE: 'the target could not be reached',
  SCOPE_UNKNOWN: "the full list of operations isn't known, so untested operations can't be ruled out",
  RESULT_TRIMMED: 'the result was trimmed to fit the size limit',
};

type Finding = DinoResult['findings'][number];

/**
 * One rule per (tool, classification). Its severity is the findings' own `normalizedLevel` (the result is
 * the only authority); two findings of one rule with different levels cannot be expressed in SARIF, so the
 * projection refuses instead of reclassifying one of them.
 */
function ruleFor(tool: DinoToolName, classification: string, level: SeverityLevel): SarifRule {
  const text = sarifRuleText(tool, classification);
  // An INFO finding is informational, not a vulnerability: GitHub has no informational security level
  // (security-severity 1.0 would read as Low), so it is a recommendation even for a security classification.
  const security = isSecurityClassification(tool, classification) && level !== 'INFO';
  return {
    id: `dino/${tool}/${classification}`,
    name: `${tool}/${classification}`,
    shortDescription: { text: text.short },
    fullDescription: { text: text.full },
    help: { text: text.help },
    properties: security
      ? { tags: ['security', 'api', tool], 'security-severity': SECURITY_SEVERITY[level] }
      : { tags: ['api', tool], 'problem.severity': PROBLEM_SEVERITY[level] },
  };
}

function logicalLocation(f: Finding): SarifLogicalLocation {
  if (f.target.kind === 'operation')
    return {
      name: f.target.operationKey,
      fullyQualifiedName: `${f.target.protocol}:${f.target.operationKey}`,
      kind: 'function',
    };
  if (f.target.kind === 'schema-element') return { name: f.target.elementKey, kind: 'member' };
  return { name: f.tool, kind: 'module' };
}

function targetLabel(f: Finding): string {
  return f.target.kind === 'run' ? `the ${f.tool} run` : canonicalTargetKey(f.target);
}

function location(anchorUri: string, logical: SarifLogicalLocation[]): SarifResult['locations'][number] {
  return {
    physicalLocation: {
      artifactLocation: { uri: anchorUri },
      region: { startLine: 1 },
    },
    logicalLocations: logical,
  };
}

async function findingResult(result: DinoResult, f: Finding, anchorUri: string): Promise<SarifResult> {
  const text = sarifRuleText(f.tool, f.classification);
  const occurrences = f.count === 1 ? '' : ` (${f.count} occurrences)`;
  return {
    ruleId: `dino/${f.tool}/${f.classification}`,
    level: RESULT_LEVEL[f.normalizedLevel],
    message: { text: `${text.short}: ${targetLabel(f)}${occurrences}.` },
    locations: [location(anchorUri, [logicalLocation(f)])],
    partialFingerprints: {
      primaryLocationLineHash: await dinoFindingFingerprint(result.identity.tenantId, f),
    },
    properties: {
      tool: f.tool,
      count: f.count,
      ...(f.authState === undefined ? {} : { authState: f.authState }),
    },
  };
}

/**
 * Why a result must not be uploaded to GitHub code scanning, or undefined when it may be. GitHub treats an
 * upload as the complete answer for its category and marks every alert missing from it as fixed, so only a
 * complete run can reconcile existing alerts: an incomplete, degraded, empty or unreachable run would turn
 * "not tested" into "fixed". Absence of evidence must never become evidence of resolution.
 */
export function sarifWithheldReason(result: DinoResult): string | undefined {
  const unverified = sarifUnverifiedReason(result);
  if (unverified !== undefined) return unverified;
  const v = result.verdict;
  if (v.incomplete) {
    const reasons = v.reasons.map((r) => REASON_TEXT[r]);
    return reasons.length === 0 ? 'coverage is incomplete' : reasons.join('; ');
  }
  return undefined;
}

/** Locale-independent order, so the category digest is the same on every machine. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** What this analysis covers: targets, selected tools and modules. Different scopes are different categories. */
function scopeKey(result: DinoResult, modules: readonly string[]): { protocols: string; scope: string } {
  const targets = result.identity.targets;
  const protocols = (['graphql', 'rest'] as const).filter((p) => targets[p] !== undefined);
  const tools = result.verification.tools
    .filter((t) => t.status !== 'not-selected')
    .map((t) => t.tool)
    .sort(byCodeUnit);
  return {
    protocols: protocols.length === 0 ? 'none' : protocols.join('+'),
    scope: [
      ...protocols.map((p) => `${p}=${targets[p]?.url ?? ''}`),
      `tools=${tools.join(',')}`,
      `modules=${[...modules].sort(byCodeUnit).join(',')}`,
    ].join('\n'),
  };
}

export function uniqueRules(findings: readonly Finding[]): SarifRule[] {
  const rules = new Map<string, SarifRule>();
  const levels = new Map<string, SeverityLevel>();
  for (const f of findings) {
    const id = `dino/${f.tool}/${f.classification}`;
    const seen = levels.get(id);
    if (seen !== undefined && seen !== f.normalizedLevel) {
      throw new DinoError({
        code: 'INTERNAL_ERROR',
        message: `SARIF cannot express rule ${id}: its findings carry different severities (${seen}, ${f.normalizedLevel}).`,
      });
    }
    if (seen === undefined) {
      levels.set(id, f.normalizedLevel);
      rules.set(id, ruleFor(f.tool, f.classification, f.normalizedLevel));
    }
  }
  return [...rules.values()].sort((a, b) => byCodeUnit(a.id, b.id));
}

/** The stable analysis category (no run segment): one owner for the renderer and the previous-analysis lookup. */
export async function sarifCategory(result: DinoResult, modules: readonly string[]): Promise<string> {
  const { protocols, scope } = scopeKey(result, modules);
  const scopeId = (await dinoResultDigest(scope)).slice(0, 12);
  const environment = result.identity.environment.split('/').join('-');
  return `dino/${environment}/${protocols}-${scopeId}`;
}

/**
 * Why a run verified nothing at all, or undefined. Such a run is never uploaded, with or without
 * reconciliation state: it has no evidence to reconcile with.
 */
export function sarifUnverifiedReason(result: DinoResult): string | undefined {
  if (result.verification.targetUnreachable) return 'the target could not be reached';
  if (result.verdict.emptyRun) return 'nothing was tested';
  if (result.verdict.degraded) return 'every selected tool failed';
  return undefined;
}

/** Stateless SARIF for a complete run: callers without reconciliation state (no previous analysis known). */
export async function renderDinoResultSarif(result: DinoResult, options: RenderSarifOptions): Promise<SarifLog> {
  const withheld = sarifWithheldReason(result);
  if (withheld !== undefined) {
    // Callers check `sarifWithheldReason` first; rendering an unreconcilable run would close real alerts.
    throw new DinoError({ code: 'INTERNAL_ERROR', message: `SARIF is only rendered for a complete run (${withheld}).` });
  }
  return buildSarifLog(result, options, await sarifRunToken(result.identity.runId, 'stateless'));
}

/** The run's own results and rules. Internal: only the two guarded entry points may call it. */
export async function buildSarifLog(result: DinoResult, options: RenderSarifOptions, runToken: string): Promise<SarifLog> {
  const { anchorUri } = options;
  const modules = options.modules ?? [];
  const results = await Promise.all(result.findings.map((f) => findingResult(result, f, anchorUri)));
  const v = result.verdict;
  return {
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Dino',
            semanticVersion: result.identity.engineVersion,
            informationUri: 'https://usedino.dev',
            rules: uniqueRules(result.findings),
          },
        },
        automationDetails: { id: `${await sarifCategory(result, modules)}/${runToken}` },
        invocations: [{ executionSuccessful: !result.verdict.incomplete }],
        results,
        properties: {
          dino: {
            resultDigest: await dinoResultDigest(canonicalDinoResultBytes(result)),
            verdict: v.health.verdict,
            overallSeverity: v.overallSeverity,
            coverage: v.coverage,
            completeness: v.completeness,
          },
        },
      },
    ],
  };
}
