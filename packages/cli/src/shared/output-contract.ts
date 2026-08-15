/**
 * Permanent output contract checkers (#2175).
 * Pure functions - structural enforcement, no keyword lists (INV-4).
 * Normative: output-observability-contract.md §WS-4, §5A.1 / §5A.4 / §5A.7.
 */

import { ScanResultV1Schema } from '@dino/engine';

export type ContractFormat = 'json' | 'markdown';

export interface LiveLeg {
  format: ContractFormat;
  stdout: string;
  stderr: string;
  exitCode: number;
  skipped?: boolean | undefined;
  skipReason?: string | undefined;
}

export interface ContractVerdict {
  pass: boolean;
  failures: string[];
  skipped: number;
  checked: number;
}

/** Exits that require a JSON error envelope as the last stderr line (§5A.7). */
const ENVELOPE_EXIT_CODES = new Set([2, 4, 5, 70]);

/** Dino-specific key prefix - safe on stdout AND stderr (zero customer collision). */
// No upper bound: `\w{4,200}\b` fails to match a >200-char key (greedy cap can't reach a word
// boundary), silently missing the backstop leak. `\w{4,}` matches any length (Maciver #2175).
const DINO_KEY_PATTERN = /\bdino_k_\w{4,}/;

/** Dino-owned stderr surfaces only - can collide with scanned customer content on stdout. */
const AUTH_HEADER_ON_STDERR = /\bAuthorization\s*:\s*(Bearer|Basic)\s+\S+/i;

/**
 * NDJSON logger envelope outside markdown fences (§5A.1.3 advisory).
 * Two independent linear tests (a `"level":"…"` string + a `"message":` key on a
 * `{`-opening line) rather than one regex with adjacent unbounded `[^}]*` groups,
 * which backtracked polynomially on crafted input like `{"level":"!"` repeated with
 * no `"message"` (CodeQL ReDoS). Each regex has a single bounded quantifier → O(n).
 */
const NDJSON_LEVEL = /"level"\s*:\s*"[^"]+"/;
const NDJSON_MESSAGE = /"message"\s*:/;
function isNdjsonLoggerLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('{') && NDJSON_LEVEL.test(trimmed) && NDJSON_MESSAGE.test(trimmed);
}

/** Local winston-style logger line: HH:MM:SS level: */
const LOCAL_LOGGER_LINE = /^\d{2}:\d{2}:\d{2}\s+(?:debug|info|warn|error|verbose|silly)\s*:/i;

function parseStdoutJson(
  stdout: string,
): { ok: true; parsed: unknown } | { ok: false; error: string } {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, error: 'empty stdout' };
  try {
    return { ok: true, parsed: JSON.parse(trimmed) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * JSON: framing purity + ScanResultV1Schema (.strict).
 * Trailing/leading bytes outside the document → pure:false (INV-1).
 */
export function checkJsonFraming(stdout: string): {
  pure: boolean;
  schemaValid: boolean;
  error?: string;
} {
  const frame = parseStdoutJson(stdout);
  if (!frame.ok) {
    return { pure: false, schemaValid: false, error: frame.error };
  }
  const schema = ScanResultV1Schema.safeParse(frame.parsed);
  if (!schema.success) {
    return { pure: true, schemaValid: false, error: schema.error.message };
  }
  return { pure: true, schemaValid: true };
}

/** Lines outside markdown fenced code blocks (customer fences ignored - INV-2). */
function standaloneLinesOutsideFences(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (t.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && t.length > 0) out.push(line);
  }
  return out;
}

/**
 * Markdown advisory: standalone logger envelope lines outside fences → leaked (INV-1).
 * NO keyword/jargon matching (INV-4).
 */
export function detectLoggerEnvelopeLeak(markdownStdout: string): {
  leaked: boolean;
  line?: string;
} {
  for (const line of standaloneLinesOutsideFences(markdownStdout)) {
    if (isNdjsonLoggerLine(line) || LOCAL_LOGGER_LINE.test(line)) {
      return { leaked: true, line: line.trim() };
    }
  }
  return { leaked: false };
}

function lastNonEmptyLine(text: string): string {
  const lines = text
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0);
  return lines.at(-1) ?? '';
}

function isErrorEnvelopeLine(line: string): boolean {
  if (!line) return false;
  try {
    const parsed = JSON.parse(line) as { error?: unknown };
    return parsed.error !== null && typeof parsed.error === 'object';
  } catch {
    return false;
  }
}

/** stderr envelope present iff exit ∈ {2,4,5,70} (Spec 2 §5A.2/§5A.7). */
export function checkExitContract(
  stderr: string,
  exitCode: number,
): { ok: boolean; error?: string } {
  const needsEnvelope = ENVELOPE_EXIT_CODES.has(exitCode);
  const hasEnvelope = isErrorEnvelopeLine(lastNonEmptyLine(stderr));
  if (needsEnvelope && !hasEnvelope) {
    return { ok: false, error: `exit ${exitCode} requires error envelope on last stderr line` };
  }
  if (!needsEnvelope && hasEnvelope) {
    return { ok: false, error: `exit ${exitCode} must not emit error envelope` };
  }
  return { ok: true };
}

/**
 * Pattern-scoped secret leak check - NOT surface-scoped for dino_k_* (backstop).
 * No email/card/provider regexes (INV-2/4); do not reuse redactEvidence.
 */
export function checkNoSecretLeak(stdout: string, stderr: string): { ok: boolean; error?: string } {
  if (DINO_KEY_PATTERN.test(stdout)) {
    return { ok: false, error: 'dino_k_* token on stdout' };
  }
  if (DINO_KEY_PATTERN.test(stderr)) {
    return { ok: false, error: 'dino_k_* token on stderr' };
  }
  if (AUTH_HEADER_ON_STDERR.test(stderr)) {
    return { ok: false, error: 'Authorization Bearer/Basic on stderr' };
  }
  return { ok: true };
}

/** Byte-identical deterministic cores (§5A.4). */
export function checkDeterministicCores(
  coreA: unknown,
  coreB: unknown,
): { ok: boolean; error?: string } {
  const a = JSON.stringify(coreA);
  const b = JSON.stringify(coreB);
  if (a !== b) {
    return { ok: false, error: 'deterministic cores differ' };
  }
  return { ok: true };
}

/** Exits that emit a RESULT document on stdout (§5A.7). Error exits (2/4/5/70) emit empty stdout
 * + an envelope on stderr — framing/logger checks do NOT apply (an empty stdout there is CORRECT,
 * not a leak). Only these get frame-checked; otherwise a non-429 transient failure (exit 4) would
 * false-red as a Dino output regression (INV-5). */
const RESULT_EXIT_CODES = new Set([0, 3, 6]);

function evaluateLeg(leg: LiveLeg): string[] {
  const failures: string[] = [];
  if (RESULT_EXIT_CODES.has(leg.exitCode)) {
    if (leg.format === 'json') {
      const framing = checkJsonFraming(leg.stdout);
      if (!framing.pure || !framing.schemaValid) {
        failures.push(`json: ${framing.error ?? 'framing or schema failure'}`);
      }
    } else {
      const leak = detectLoggerEnvelopeLeak(leg.stdout);
      if (leak.leaked) {
        failures.push(`markdown logger leak: ${leak.line ?? 'detected'}`);
      }
    }
  }
  // secret + exit-contract apply to EVERY leg (a leaked dino_k_ or a wrong envelope is a failure
  // regardless of exit code; empty-stdout error legs still get these).
  const secrets = checkNoSecretLeak(leg.stdout, leg.stderr);
  if (!secrets.ok) failures.push(`secret: ${secrets.error ?? 'detected'}`);
  const exit = checkExitContract(leg.stderr, leg.exitCode);
  if (!exit.ok) failures.push(`exit: ${exit.error ?? 'contract violation'}`);
  return failures;
}

/**
 * Aggregate legs into one honest verdict.
 * INV-3: pass=false when checked===0 (all skipped/inconclusive ≠ clean PASS).
 */
export function judgeContract(legs: LiveLeg[]): ContractVerdict {
  let skipped = 0;
  let checked = 0;
  const failures: string[] = [];

  for (const leg of legs) {
    if (leg.skipped === true) {
      skipped += 1;
      continue;
    }
    checked += 1;
    failures.push(...evaluateLeg(leg));
  }

  return {
    pass: failures.length === 0 && checked > 0,
    failures,
    skipped,
    checked,
  };
}
