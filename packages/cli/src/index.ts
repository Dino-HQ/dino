/**
 * @dino/cli — CLI entry point (Issue #307).
 * Spec: docs/CLI_SPEC.md
 */

import { sanitizeEventError } from '@dino/analytics';
import { recordGet } from '@dino/core';
import { setLogLevel } from '@dino/engine';
import { runLogin, runLogout, runWhoami } from './commands/auth';
import { runChangelog } from './commands/changelog';
import { runConfigFromArgv } from './commands/config';
import { runDiff } from './commands/diff';
import { runDocs } from './commands/docs';
import { runInit } from './commands/init';
import { runLint } from './commands/lint';
import { runRunnerFromFlags } from './commands/runner';
import { runScan } from './commands/scan';
import { runValidate } from './commands/validate';
import { runVerify } from './commands/verify';
import { runWatch } from './commands/watch';
import { loadCliConfig } from './config/loader';
import { parseArgs, buildContext } from './shared/base-command';
import { quickstartText, usageText } from './shared/cli-usage';
import { printCommandHelp } from './shared/command-help';
import { CliError } from './shared/errors';
import { runInitScanNow } from './shared/init-scan-now';
import { printError, detectUi } from './shared/ui';
import { CLI_VERSION } from './version';
import type { CommandContext, MergedFlags } from './shared/base-command';

export { usageText, quickstartText } from './shared/cli-usage';

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
export { runVerify } from './commands/verify';
export { runLogin, runLogout, runWhoami } from './commands/auth';
export { getValidToken, readStoredToken } from './auth/token-store';
export type { StoredToken } from './auth/token-store';
export type { PkcePair, OAuthEnvConfig, OidcEndpoints } from './auth/oauth-core';
export {
  runInit,
  buildConfigYaml,
  checkEndpoint,
  remainingInitPromptQuestions,
} from './commands/init';
export type { InitFlags } from './commands/init';
export type { DinoCliConfig } from './config/loader';
export type { CommonFlags, CommandContext, MergedFlags } from './shared/base-command';
export {
  parseArgs,
  buildContext,
  buildAuthHeaders,
  parseHeaderArg,
  resolveAuthHeaders,
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
  printNotice,
  printHeaderBanner,
} from './shared/ui';
export type { UiOptions, ChalkColor, HeaderBannerMeta } from './shared/ui';
export { computeGlobalHealthScore, withStaticHeaders } from './shared/pipeline-helpers';

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
export { renderViewSafe, shouldRenderInkView } from './ink/InkRender';

/** Split comma-separated --tools and --modules into arrays (#573). Used by main() and tests. */
export function normalizeToolsAndModules(flags: Record<string, unknown>): void {
  if (typeof flags.tools === 'string') {
    flags.tools = flags.tools.split(',').map((t: string) => t.trim());
  }
  if (typeof flags.modules === 'string') {
    flags.modules = flags.modules.split(',').map((m: string) => m.trim());
  }
}

function printUsage(opts?: { stream?: 'stdout' | 'stderr' }): void {
  const writer = opts?.stream === 'stderr' ? console.error : console.info;
  writer(usageText());
}

/** Check if argv requests version or help output. Returns exit code 0 if handled, null otherwise. */
function handleEarlyExit(
  command: string | undefined,
  flags: Record<string, unknown>,
): number | null {
  // #173: bare words `dino version` / `dino help` alias the flag forms
  if (
    flags.version === true ||
    flags.v === true ||
    command === '--version' ||
    command === '-v' ||
    command === 'version'
  ) {
    console.info(CLI_VERSION);
    return 0;
  }
  const helpRequested =
    flags.help === true ||
    flags.h === true ||
    command === '--help' ||
    command === '-h' ||
    command === 'help';
  if (helpRequested) {
    // #2141: `dino <command> --help` shows that command's help, not the top-level banner.
    // `dino help` is the bare-word alias for top-level help (not a named command).
    const named =
      command !== undefined && command !== '--help' && command !== '-h' && command !== 'help';
    if (named && printCommandHelp(command)) {
      return 0;
    }
    printUsage();
    return 0;
  }
  if (!command) {
    // #2160: no-args → quickstart (explicit --help still uses full usage above)
    console.info(quickstartText());
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

/** Coerced booleans + tenant/format slice merged last into pipeline handlers. */
type TenantCliCommonFlags = {
  tenant: string;
  env: string | undefined;
  format: ReturnType<typeof validateFormat>;
  quiet: boolean;
  verbose: boolean;
  debug: boolean;
  noColor: boolean;
  endpoint: string | undefined;
  protocol: ('graphql' | 'rest') | undefined;
  specUrl: string | undefined;
  header: string | string[] | undefined;
  token: string | undefined;
};

/** Options for handleCommandError. */
interface HandleCommandErrorOptions {
  err: unknown;
  context: CommandContext;
  command: string;
  startMs: number;
  flags: Record<string, unknown>;
}

function handleCommandError(opts: HandleCommandErrorOptions): number {
  const { err, context, command, startMs, flags } = opts;
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
      errorClass: err instanceof Error ? err.name : 'Unknown',
    },
  });
  const ui = detectUi({
    quiet: false,
    noColor: flags.noColor === true,
  });
  printError(err instanceof Error ? err : new Error(String(err)), ui, flags.debug === true);
  return exitCode;
}

/**
 * Merged flags type at the dispatch boundary — CommonFlags from CLI parsing
 * plus extra keys from parseArgs and loaded config. Each handler structurally
 * accepts this because its XFlags extends CommonFlags.
 */
type CommandHandler = (ctx: CommandContext, f: MergedFlags) => Promise<number>;

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  scan: runScan,
  docs: runDocs,
  diff: runDiff,
  watch: runWatch,
  lint: runLint,
  changelog: runChangelog,
};

/**
 * Runner + verify + auth commands bypass tenant YAML, tracker, and merged flag coercion.
 */
async function runBareCommand(
  run: () => Promise<number>,
  flags: Record<string, unknown>,
): Promise<number> {
  try {
    return await run();
  } catch (err) {
    const ui = detectUi({ quiet: false, noColor: flags.noColor === true });
    printError(err instanceof Error ? err : new Error(String(err)), ui, flags.debug === true);
    return err instanceof CliError ? err.exitCode : 1;
  }
}

async function runWithoutTenantContext(
  command: string,
  flags: Record<string, unknown>,
): Promise<number | null> {
  if (command === 'runner') {
    return runRunnerFromFlags(flags);
  }
  if (command === 'verify') {
    return runBareCommand(() => runVerify(flags), flags);
  }
  if (command === 'login') {
    return runBareCommand(() => runLogin(flags), flags);
  }
  if (command === 'logout') {
    return runBareCommand(() => runLogout(flags), flags);
  }
  if (command === 'whoami') {
    return runBareCommand(() => runWhoami(flags), flags);
  }
  return null;
}

interface InvokeTrackedPipelineOptions {
  context: CommandContext;
  command: string;
  handler: CommandHandler;
  config: Awaited<ReturnType<typeof loadCliConfig>>;
  flags: Record<string, unknown>;
  commonFlags: TenantCliCommonFlags;
}

async function invokeTrackedPipelineCommand(opts: InvokeTrackedPipelineOptions): Promise<number> {
  const { context, command, handler, config, flags, commonFlags } = opts;
  const commandStartMs = Date.now(); // determinism:allowed
  try {
    // commonFlags spread LAST — coerced booleans (quiet, verbose, debug, noColor)
    // must not be overridden by raw string values from parseArgs (e.g., --quiet false → 'false' is truthy).
    // Command-specific flags from config and parseArgs come first.
    const mergedFlags = { ...config, ...flags, ...commonFlags } as MergedFlags;
    normalizeToolsAndModules(mergedFlags);
    return await handler(context, mergedFlags);
  } catch (err) {
    return handleCommandError({ err, context, command, startMs: commandStartMs, flags });
  } finally {
    await context.tracker.shutdown();
  }
}

function buildTenantCliCommonFlags(
  flags: Record<string, unknown>,
  config: Awaited<ReturnType<typeof loadCliConfig>>,
): TenantCliCommonFlags {
  return {
    tenant: (flags.tenant ?? config?.tenant) as string,
    env: flags.env as string | undefined,
    format: validateFormat(flags.format as string | undefined),
    quiet: flags.quiet === true,
    verbose: flags.verbose === true, // #560
    debug: flags.debug === true,
    noColor: flags.noColor === true,
    endpoint: flags.endpoint as string | undefined, // #171
    protocol: flags.protocol as ('graphql' | 'rest') | undefined, // #171
    specUrl: flags.specUrl as string | undefined, // #171
    header: flags.header as string | string[] | undefined, // #2160
    token: flags.token as string | undefined, // #2160
  };
}

/** Tenant-backed commands: config load, format coercion, tracker lifecycle. */
async function runTenantBackedCommand(
  argv: string[],
  command: string,
  flags: Record<string, unknown>,
): Promise<number> {
  const config = await loadCliConfig({
    tenantId: typeof flags.tenant === 'string' ? flags.tenant : undefined,
  });

  const rawFormat = flags.format as string | undefined;
  if (rawFormat !== undefined && !VALID_FORMATS.has(rawFormat)) {
    console.error(`Invalid --format: "${rawFormat}". Valid: markdown, json`);
    return 1;
  }

  const commonFlags = buildTenantCliCommonFlags(flags, config);

  if (command === 'validate') {
    return runValidate(null, { quiet: commonFlags.quiet, noColor: commonFlags.noColor });
  }
  if (command === 'init') {
    return runInit({
      quiet: commonFlags.quiet,
      force: flags.force === true,
      onScanNow: () => runInitScanNow(commonFlags),
    });
  }
  if (command === 'config') {
    return runConfigFromArgv(argv);
  }

  const handler = recordGet(COMMAND_HANDLERS, command);
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage({ stream: 'stderr' });
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

  return invokeTrackedPipelineCommand({
    context,
    command,
    handler,
    config,
    flags,
    commonFlags,
  });
}

/**
 * Main CLI entry point. Parses argv, routes to command handler.
 * Returns process exit code.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command, flags } = parseArgs(argv);

  // #2143: the default happy path shows ONLY product output — the report plus product notices
  // the CLI prints itself (see printNotice). Internal engine logs (introspecting endpoint,
  // introspection fallback, pipeline progress, registry mapping) stay hidden until
  // `--verbose` (info) / `--debug` (debug). Default and `--quiet` suppress everything below
  // `error`; the CLI surfaces user-relevant conditions via product notices, not raw logs.
  // An explicit DINO_LOG_LEVEL env var still wins for power users and CI.
  if (process.env.DINO_LOG_LEVEL === undefined) {
    let level: 'debug' | 'info' | 'error' = 'error';
    if (flags.debug === true) {
      level = 'debug';
    } else if (flags.verbose === true) {
      level = 'info';
    }
    setLogLevel(level);
  }

  const earlyExit = handleEarlyExit(command, flags);
  if (earlyExit !== null) return earlyExit;

  const noTenant = await runWithoutTenantContext(command, flags);
  if (noTenant !== null) return noTenant;

  return runTenantBackedCommand(argv, command, flags);
}
