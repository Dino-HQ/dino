/**
 * Per-command help for `dino <command> --help` (#2141).
 * Extracted from index.ts to keep it under the 400-line file cap.
 * Options here are verified against each command's own flag handling — not the top-level banner.
 */
import { recordGet } from '@dino/core';
import { emitResult } from './emit-result';

interface CommandHelp {
  summary: string;
  usage: string;
  options: string[];
}

const COMMON_OPTIONS_HINT =
  'Common options: --tenant <id>  --env <name>  --format <markdown|json>  --quiet  --verbose  --debug  --no-color';

const COMMAND_HELP: Record<string, CommandHelp> = {
  scan: {
    summary:
      'Run the full test pipeline (fuzzing, validation, RBAC, rate limits, error codes, deprecation).',
    usage: 'dino scan --tenant <id> [--env <name>] [options]',
    options: [
      '--endpoint <url>      Ad-hoc scan target (no .dino.yml needed)',
      '--protocol <type>     graphql (default) | rest',
      '--spec-url <url|path> OpenAPI spec: required when --protocol rest',
      '--header <"Name: Value">  Send a static auth header (repeatable)',
      '--token <token>        Shortcut for --header "Authorization: Bearer <token>"',
      '--fail-on-high        Exit 3 if HIGH or CRITICAL findings exist',
      '--tools <list>        Comma-separated tools to run (default: all)',
      '--modules <list>      Comma-separated modules to scan (default: all)',
      '--reasoning           Enable AI reasoning (requires an Anthropic API key)',
      '--accept-partial      Treat a reduced-coverage (partial) scan as success: exit 0 instead of 6',
    ],
  },
  watch: {
    summary: 'Run scheduled scans with Shadow Mode (observe or enforce).',
    usage: 'dino watch --tenant <id> [options]',
    options: [
      '--autonomy <mode>     Shadow Mode: observe (default) or enforce',
      '--once                Run a single scan and exit (alias for --iterations 1)',
      '--interval <sec>      Seconds between scans (default: 300)',
      '--iterations <n>      Maximum number of scan iterations',
    ],
  },
  docs: {
    summary: 'Generate API documentation from live introspection.',
    usage: 'dino docs --tenant <id> [--format <markdown|json>]',
    options: [],
  },
  diff: {
    summary: 'Compare the current schema against a saved snapshot.',
    usage: 'dino diff --tenant <id> [options]',
    options: ['--fail-on-breaking    Exit 3 if breaking changes are detected'],
  },
  lint: {
    summary: 'Check schema descriptions (fails on new undocumented operations).',
    usage: 'dino lint --tenant <id> [options]',
    options: ['--fail-on-undocumented   Exit 3 if new undocumented operations are found'],
  },
  changelog: {
    summary: 'Generate a changelog from schema snapshot diffs.',
    usage: 'dino changelog --tenant <id> [options]',
    options: [
      '--fail-on-breaking    Exit 3 if breaking changes are detected',
      '--from <id>           Compare against a specific snapshot ID',
    ],
  },
  runner: {
    summary: 'Cloud runner: register this machine, then start polling for scan jobs.',
    usage: 'dino runner <register|start> [options]',
    options: [],
  },
  verify: {
    summary: 'Verify a scan DCG against its Sigstore attestation.',
    usage: 'dino verify --cloud-endpoint <url> --token <token>',
    options: [],
  },
  login: {
    summary:
      'Authenticate via browser (Connected Apps + PKCE); stores a token in ~/.dino/credentials.json.',
    usage: 'dino login [--api-url <url>]',
    options: [],
  },
  logout: {
    summary: 'Clear stored credentials (best-effort server revoke).',
    usage: 'dino logout',
    options: [],
  },
  whoami: {
    summary: 'Show the active tenant for the current login.',
    usage: 'dino whoami',
    options: [],
  },
  validate: {
    summary: 'Validate .dino.yml config (with helpful error messages).',
    usage: 'dino validate',
    options: [],
  },
  init: {
    summary: 'Set up your project: generates .dino.yml interactively or headlessly for agents/CI.',
    usage:
      'dino init [--yes] [--force] [--dry-run] [--format json] [--endpoint URL] [--protocol graphql|rest] [--auth none|header|oauth2] …',
    options: [
      '--yes                 Force non-interactive mode (no prompts)',
      '--dry-run             Preview config without writing',
      '--format json         Machine-readable result document on stdout',
      '--force               Overwrite an existing .dino.yml that differs',
      '--endpoint URL        API endpoint (required in non-interactive mode)',
      '--protocol graphql|rest  Protocol (required in non-interactive mode)',
      '--spec-url URL        OpenAPI spec URL/path (required when protocol=rest)',
      '--auth none|header|oauth2  Auth mode (required in non-interactive mode)',
      '--auth-header NAME    HTTP header name (required when auth=header)',
      '--auth-scheme TOKEN   Header scheme e.g. Bearer (optional)',
      '--auth-value-env VAR  Env var holding the token (required when auth=header)',
      '--oauth2-token-endpoint URL  Token endpoint (required when auth=oauth2)',
      '--oauth2-client-id-env VAR   Client id env var (required when auth=oauth2)',
      '--oauth2-client-secret-env VAR  Client secret env var (required when auth=oauth2)',
      '--oauth2-scope SCOPE  OAuth2 scope (optional)',
      'DINO_INIT_* env vars  Fallback for each flag (flag wins over env)',
      '(env-var flags take a NAME: letters/digits/underscore, not starting with a digit; never a secret value)',
    ],
  },
  config: {
    summary: 'Configure CLI preferences (e.g. telemetry).',
    usage: 'dino config telemetry [off|crash|all]',
    options: [
      'telemetry [off|crash|all]   Set the telemetry level (omit the level to show the current one)',
    ],
  },
};

/** Print help for a single command. Returns true if `command` was a known command. */
export function printCommandHelp(command: string): boolean {
  const help = recordGet(COMMAND_HELP, command);
  if (!help) return false;
  const lines = [`dino ${command}: ${help.summary}`, '', `Usage: ${help.usage}`];
  if (help.options.length > 0) {
    lines.push('', 'Options:', ...help.options.map((o) => `  ${o}`));
  }
  lines.push('', COMMON_OPTIONS_HINT);
  // #2172: command help is a requested stdout RESULT
  emitResult(lines.join('\n'));
  return true;
}
