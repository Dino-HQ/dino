/**
 * @dino/cli — CLI entry point (Issue #307).
 * Spec: docs/CLI_SPEC.md
 */

import { parseArgs, buildContext } from './shared/base-command';
import { CliError } from './shared/errors';
import { printError, detectUi } from './shared/ui';
import type { CommandContext } from './shared/base-command';
import { sanitizeEventError } from '@dino/analytics';
import { recordGet } from '@dino/core';
import { loadCliConfig } from './config/loader';
import { runScan } from './commands/scan';
import { runDocs } from './commands/docs';
import { runDiff } from './commands/diff';
import { runWatch } from './commands/watch';
import { runLint } from './commands/lint';
import { runChangelog } from './commands/changelog';
import { runValidate } from './commands/validate';
import { runInit } from './commands/init';
import { CLI_VERSION } from './version';

export { runScan } from './commands/scan';
export type { ScanFlags } from './commands/scan';
export { runDocs } from './commands/docs';
export type { DocsFlags } from './commands/docs';
export { runDiff } from './commands/diff';
export type { DiffFlags } from './commands/diff';
export { runWatch } from './commands/watch';
export type { WatchFlags, AutonomyLevel } from './commands/watch';
export { runLint } from './commands/lint';
export type { LintFlags } from './commands/lint';
export { runChangelog } from './commands/changelog';
export type { ChangelogFlags } from './commands/changelog';
export { saveHistoryEntry, loadHistory } from './shared/history';
export type { WatchHistoryEntry } from './shared/history';
export { loadCliConfig } from './config/loader';
export { runValidate } from './commands/validate';
export type { ValidateFlags } from './commands/validate';
export { runInit, buildConfigYaml, checkEndpoint } from './commands/init';
export type { InitFlags } from './commands/init';
export type { DinoCliConfig } from './config/loader';
export type { CommonFlags, CommandContext } from './shared/base-command';
export {
  parseArgs,
  buildContext,
  getEndpoint,
  discoverOperations,
  withTracking,
} from './shared/base-command';
export { CliError } from './shared/errors';
export { CLI_VERSION } from './version';
export {
  detectUi,
  createSpinner,
  colorize,
  healthLabel,
  durationLabel,
  printError,
} from './shared/ui';
export type { UiOptions, ChalkColor } from './shared/ui';
export { computeGlobalHealthScore } from './shared/pipeline-helpers';

// Ink design system (#1014)
export { DINO_THEME } from './ink/theme';
export type { DinoColor } from './ink/theme';
export { DinoHeader } from './ink/DinoHeader';
export { SummaryCard } from './ink/SummaryCard';
export type { SummaryStat } from './ink/SummaryCard';
export { HealthBadge } from './ink/HealthBadge';
export { StatusIcon } from './ink/StatusIcon';
export type { StatusKind } from './ink/StatusIcon';
export { DinoSpinner } from './ink/DinoSpinner';
export { ErrorPanel } from './ink/ErrorPanel';
export { Divider } from './ink/Divider';
export { ProgressBar } from './ink/ProgressBar';
export { NextStep } from './ink/NextStep';
export { FindingsTable } from './ink/FindingsTable';
export type { FindingRow } from './ink/FindingsTable';
export { DiffBadge } from './ink/DiffBadge';
export type { DiffBadgeType } from './ink/DiffBadge';
export { renderViewSafe, shouldRenderInkView } from './ink/render';

/** Split comma-separated --tools and --modules into arrays (#573). Used by main() and tests. */
export function normalizeToolsAndModules(flags: Record<string, unknown>): void {
  if (typeof flags.tools === 'string') {
    flags.tools = flags.tools.split(',').map((t: string) => t.trim());
  }
  if (typeof flags.modules === 'string') {
    flags.modules = flags.modules.split(',').map((m: string) => m.trim());
  }
}

function printUsage(): void {
  console.info(`dino v${CLI_VERSION} — AI-powered API quality scanner

Usage: dino <command> [options]

Commands:
  scan   Run the full test pipeline (fuzzing, validation, RBAC, rate limits, error codes, deprecation)
  watch  Run scheduled scans with Shadow Mode (observe or enforce)
  docs   Generate API documentation from live introspection
  diff   Compare current schema against a saved snapshot
  lint   Check schema descriptions (fails on new undocumented ops)
  changelog  Generate a changelog from schema snapshot diffs
  validate   Validate .dino.yml config (with helpful error messages)
  init       Set up your project — generates .dino.yml interactively

Common options:
  --tenant <id>       Tenant configuration to use (required)
  --env <name>        Target environment (default: tenant's default)
  --format <type>     Output format: markdown | json
  --quiet             Suppress non-essential output
  --verbose           Show applied defaults and internal diagnostics
  --debug             Show full stack traces on errors
  --no-color          Disable all color output (also respects NO_COLOR env var)
  --help, -h          Show this help message
  --version, -v       Show version number

Scan options:
  --fail-on-high          Exit 1 if HIGH or CRITICAL findings exist

Lint options:
  --fail-on-undocumented  Exit 1 if new undocumented operations are found

Diff options:
  --fail-on-breaking      Exit 1 if breaking changes are detected

Changelog options:
  --fail-on-breaking      Exit 1 if breaking changes are detected
  --from <id>             Compare against a specific snapshot ID

Watch options:
  --autonomy <mode>   Shadow Mode: observe (default) or enforce
  --once              Run a single scan and exit (alias for --iterations 1)
  --interval <sec>    Seconds between scans (default: 300)
  --iterations <n>    Maximum number of scan iterations

Run "dino <command> --help" for command-specific options.`);
}

/** Check if argv requests version or help output. Returns exit code 0 if handled, null otherwise. */
function handleEarlyExit(
  command: string | undefined,
  flags: Record<string, unknown>,
): number | null {
  if (flags.version === true || flags.v === true || command === '--version' || command === '-v') {
    console.info(CLI_VERSION);
    return 0;
  }
  if (
    flags.help === true ||
    flags.h === true ||
    command === '--help' ||
    command === '-h' ||
    !command
  ) {
    printUsage();
    return 0;
  }
  return null;
}

// B14 (#587): Validate --format before dispatch — unknown values silently fall through to markdown
const VALID_FORMATS = new Set(['markdown', 'json']);

function validateFormat(raw: string | undefined): 'markdown' | 'json' | undefined {
  if (raw !== undefined && !VALID_FORMATS.has(raw)) {
    console.error(`Invalid --format: "${raw}". Valid: markdown, json`);
    return undefined;
  }
  return raw as 'markdown' | 'json' | undefined;
}

function handleCommandError(
  err: unknown,
  context: CommandContext,
  command: string,
  startMs: number,
  flags: Record<string, unknown>,
): number {
  const durationMs = Date.now() - startMs; // determinism:allowed
  // B15 (#588): Read CliError.exitCode instead of hardcoding 1
  const exitCode = err instanceof CliError ? err.exitCode : 1;
  context.tracker.track({
    type: 'cli.command.failed',
    timestamp: new Date().toISOString(), // determinism:allowed
    tenantId: context.tenantId,
    properties: {
      command: command || 'unknown',
      durationMs,
      error: sanitizeEventError(err instanceof Error ? err.message : String(err)),
    },
  });
  const ui = detectUi({
    quiet: false,
    noColor: flags.noColor === true,
  });
  printError(err instanceof Error ? err : new Error(String(err)), ui, flags.debug === true);
  return exitCode;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dispatch map avoids 6 if-chains (CC reduction)
const COMMAND_HANDLERS: Record<string, (ctx: CommandContext, f: any) => Promise<number>> = {
  scan: runScan,
  docs: runDocs,
  diff: runDiff,
  watch: runWatch,
  lint: runLint,
  changelog: runChangelog,
};

/**
 * Main CLI entry point. Parses argv, routes to command handler.
 * Returns process exit code.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command, flags } = parseArgs(argv);

  const earlyExit = handleEarlyExit(command, flags);
  if (earlyExit !== null) return earlyExit;

  const config = await loadCliConfig({
    tenantId: typeof flags.tenant === 'string' ? flags.tenant : undefined,
  });

  const rawFormat = flags.format as string | undefined;
  if (rawFormat !== undefined && !VALID_FORMATS.has(rawFormat)) {
    console.error(`Invalid --format: "${rawFormat}". Valid: markdown, json`);
    return 1;
  }

  const commonFlags = {
    tenant: (flags.tenant ?? config?.tenant) as string,
    env: flags.env as string | undefined,
    format: validateFormat(rawFormat),
    quiet: flags.quiet === true,
    verbose: flags.verbose === true, // #560
    debug: flags.debug === true,
    noColor: flags.noColor === true,
  };

  // #558: dino validate runs without tenant context (INV-4)
  if (command === 'validate') {
    return runValidate(null, { quiet: commonFlags.quiet, noColor: commonFlags.noColor });
  }

  // #322: dino init runs without tenant context (INV-4)
  if (command === 'init') {
    return runInit({ quiet: commonFlags.quiet, force: flags.force === true });
  }

  const handler = recordGet(COMMAND_HANDLERS, command);
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
  }

  let context: CommandContext;
  try {
    context = buildContext(commonFlags, config);
  } catch (err) {
    const ui = detectUi({ quiet: false, noColor: commonFlags.noColor });
    printError(err instanceof Error ? err : new Error(String(err)), ui, commonFlags.debug);
    return err instanceof CliError ? err.exitCode : 1;
  }

  const commandStartMs = Date.now(); // determinism:allowed
  try {
    const mergedFlags = { ...config, ...commonFlags, ...flags };
    normalizeToolsAndModules(mergedFlags);
    return await handler(context, mergedFlags);
  } catch (err) {
    return handleCommandError(err, context, command, commandStartMs, flags);
  } finally {
    await context.tracker.shutdown();
  }
}
