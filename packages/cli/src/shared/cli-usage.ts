/**
 * Top-level CLI usage / quickstart copy (#2160).
 */

import { CLI_VERSION } from '../version';

/** Full usage for explicit `dino --help`. */
export function usageText(): string {
  return `dino v${CLI_VERSION}: AI-powered API quality scanner

Usage: dino <command> [options]

Commands:
  scan   Run the full test pipeline (fuzzing, validation, RBAC, rate limits, error codes, deprecation)
  config Configure CLI preferences (e.g. telemetry)
  watch  Run scheduled scans with Shadow Mode (observe or enforce)
  docs   Generate API documentation from your live API
  diff   Compare current schema against a saved snapshot
  lint   Check schema descriptions (fails on new undocumented ops)
  changelog  Generate a changelog from schema snapshot diffs
  runner     Cloud runner: \`dino runner register\` then \`dino runner start\`
  verify     Verify a scan's result against its Sigstore attestation (requires --cloud-endpoint and --token)
  login      Authenticate via browser (Connected Apps + PKCE); stores token in ~/.dino/credentials.json
  logout     Clear stored credentials (best-effort server revoke)
  whoami     Show the active tenant for the current login
  validate   Validate .dino.yml config (with helpful error messages)
  init       Set up your project: generates .dino.yml interactively

Common options:
  --tenant <id>       Tenant config to use (or --endpoint for an ad-hoc scan)
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
  --header <"Name: Value"> Send a static auth header (repeatable)
  --token <token>          Shortcut for --header "Authorization: Bearer <token>"

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

Run "dino <command> --help" for command-specific options.`;
}

/** #2160: bare `dino` prints a short quickstart, not the 14-command dump. */
export function quickstartText(): string {
  return `dino v${CLI_VERSION}: AI-powered API quality scanner

Get started:
  dino scan --endpoint <url>
  dino init
  dino --help
`;
}
