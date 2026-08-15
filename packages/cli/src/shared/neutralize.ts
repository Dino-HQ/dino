/**
 * Per-context neutralization for customer-controlled content (CWE-117).
 * Spec #2172 - fails closed: never pass through bytes/metacharacters we cannot make safe.
 */

import type { OperationCatalogEntry } from '@dino/engine';

export type NeutralizeContext = 'markdown' | 'terminal' | 'json';

const ESC = 0x1b;
const CSI_SINGLE = 0x9b;
const BEL = 0x07;
const DEL = 0x7f;

function codePointLength(code: number): number {
  return code > 0xffff ? 2 : 1;
}

/** Consume CSI parameters starting after the introducer; ends at 0x40-0x7E. */
function consumeCsi(input: string, start: number): number {
  let i = start;
  while (i < input.length) {
    const code = input.codePointAt(i);
    if (code === undefined) {
      return i;
    }
    i += codePointLength(code);
    if (code >= 0x40 && code <= 0x7e) {
      break;
    }
  }
  return i;
}

/** Consume OSC starting after ESC ]; ends at BEL or ST (ESC \). */
function consumeOsc(input: string, start: number): number {
  let i = start;
  while (i < input.length) {
    const code = input.codePointAt(i);
    if (code === undefined) {
      return i;
    }
    i += codePointLength(code);
    if (code === BEL) {
      break;
    }
    if (code === ESC && i < input.length && input.codePointAt(i) === 0x5c) {
      i += 1;
      break;
    }
  }
  return i;
}

/** Advance past ESC-prefixed CSI/OSC (or drop a lone ESC). Returns new index. */
function skipEscSequence(input: string, afterEsc: number): number {
  if (afterEsc >= input.length) {
    return afterEsc;
  }
  const next = input.codePointAt(afterEsc);
  if (next === 0x5b) {
    return consumeCsi(input, afterEsc + 1);
  }
  if (next === 0x5d) {
    return consumeOsc(input, afterEsc + 1);
  }
  return afterEsc;
}

function isDroppedControl(code: number): boolean {
  if (code <= 0x1f && code !== 0x09 && code !== 0x0a) {
    return true;
  }
  return code === DEL || (code >= 0x80 && code <= 0x9f);
}

/**
 * Strip ANSI (CSI/OSC) and C0/C1 control bytes except `\t` / `\n`.
 * Uses a code-point loop (no control-char regex - satisfies no-control-regex).
 */
export function stripControlsAndAnsi(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const code = input.codePointAt(i);
    if (code === undefined) {
      break;
    }
    const len = codePointLength(code);

    if (code === ESC) {
      i = skipEscSequence(input, i + len);
      continue;
    }
    if (code === CSI_SINGLE) {
      i = consumeCsi(input, i + len);
      continue;
    }
    if (isDroppedControl(code)) {
      i += len;
      continue;
    }

    out += String.fromCodePoint(code);
    i += len;
  }
  return out;
}

const ESCAPED_HASH = String.raw`\#`;

function escapeLeadingHashes(line: string): string {
  return line.replace(/^(\s*)(#+)/u, (_m, ws: string, hashes: string) => {
    return `${ws}${hashes.replaceAll('#', ESCAPED_HASH)}`;
  });
}

function escapeMarkdownStructure(input: string): string {
  // Backslash MUST be first — otherwise `a\|b` → `a\\|b` (escaped `\`, active `|`).
  let out = input.replaceAll('\\', '\\\\');
  out = out.replaceAll('```', String.raw`\`\`\``).replaceAll('~~~', String.raw`\~\~\~`);
  out = out.replaceAll('|', String.raw`\|`).replaceAll('<', String.raw`\<`);
  return out.split('\n').map(escapeLeadingHashes).join('\n');
}

/**
 * Make customer-controlled content safe for the target output context.
 * Never returns content it failed to make safe (INV-4).
 */
export function neutralize(untrusted: string, context: NeutralizeContext): string {
  const stripped = stripControlsAndAnsi(untrusted);
  if (context === 'terminal') {
    return stripped;
  }
  if (context === 'json') {
    // JSON.stringify on the caller side escapes structurally; we only normalize controls.
    return stripped;
  }
  return escapeMarkdownStructure(stripped);
}

type ToolFinding = OperationCatalogEntry['toolFindings']['byTool'][string];

function neutralizeToolFindings(
  byTool: OperationCatalogEntry['toolFindings']['byTool'],
  context: NeutralizeContext,
): OperationCatalogEntry['toolFindings']['byTool'] {
  const entries = Object.entries(byTool).map(([tool, finding]): [string, ToolFinding] => {
    const next: ToolFinding = {
      ...finding,
      examples: (finding.examples ?? []).map((ex) => neutralize(ex, context)),
    };
    return [tool, next];
  });
  return Object.fromEntries(entries);
}

/** Neutralize customer-controlled fields on a catalog entry before it enters a report. */
export function neutralizeCatalogCustomerFields(
  entry: OperationCatalogEntry,
  context: NeutralizeContext,
): OperationCatalogEntry {
  const sourceByTool = entry.toolFindings?.byTool ?? {};
  const rawDescription = entry.schemaDescription;
  // doc-renderer.ts prints:
  //   returnType (REST heading :213/:217), parameters[].name (:235-237),
  //   module (group heading :294). args[] / requestBody are not rendered — leave them.
  const parameters =
    entry.parameters === undefined
      ? undefined
      : entry.parameters.map((p) => ({
          ...p,
          name: neutralize(p.name, context),
        }));
  return {
    ...entry,
    name: neutralize(entry.name, context),
    module: neutralize(entry.module, context),
    returnType: neutralize(entry.returnType, context),
    ...(parameters === undefined ? {} : { parameters }),
    schemaDescription:
      rawDescription === null || rawDescription === undefined
        ? null
        : neutralize(rawDescription, context),
    toolFindings: {
      toolsRun: entry.toolFindings?.toolsRun ?? [],
      worstSeverity: entry.toolFindings?.worstSeverity ?? 'CLEAN',
      byTool: neutralizeToolFindings(sourceByTool, context),
    },
  };
}
