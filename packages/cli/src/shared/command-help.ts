/**
 * Per-command help for `dino <command> --help` (#2141).
 * Extracted from index.ts to keep it under the 400-line file cap.
 * Options here are verified against each command's own flag handling — not the top-level banner.
 */
import { recordGet } from '@dino/core';

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
      '--fail-on-high        Exit 1 if HIGH or CRITICAL findings exist',
      '--tools <list>        Comma-separated tools to run (default: all)',
      '--modules <list>      Comma-separated modules to scan (default: all)',
      '--reasoning           Enable AI reasoning (requires an Anthropic API key)',
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
    options: ['--fail-on-breaking    Exit 1 if breaking changes are detected'],
  },
  lint: {
    summary: 'Check schema descriptions (fails on new undocumented operations).',
    usage: 'dino lint --tenant <id> [options]',
    options: ['--fail-on-undocumented   Exit 1 if new undocumented operations are found'],
  },
  changelog: {
    summary: 'Generate a changelog from schema snapshot diffs.',
    usage: 'dino changelog --tenant <id> [options]',
    options: [
      '--fail-on-breaking    Exit 1 if breaking changes are detected',
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
    summary: 'Set up your project — generates .dino.yml interactively.',
    usage: 'dino init [--force]',
    options: ['--force               Overwrite an existing .dino.yml'],
  },
  config: {
    summary: 'Configure CLI preferences (e.g. telemetry).',
    usage: 'dino config [get|set] [key] [value]',
    options: [],
  },
};

/** Print help for a single command. Returns true if `command` was a known command. */
export function printCommandHelp(command: string): boolean {
  const help = recordGet(COMMAND_HELP, command);
  if (!help) return false;
  const lines = [`dino ${command} — ${help.summary}`, '', `Usage: ${help.usage}`];
  if (help.options.length > 0) {
    lines.push('', 'Options:', ...help.options.map((o) => `  ${o}`));
  }
  lines.push('', COMMON_OPTIONS_HINT);
  console.info(lines.join('\n'));
  return true;
}
