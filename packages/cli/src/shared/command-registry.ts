/**
 * @dino/cli - COMMAND_REGISTRY: single source of truth for CLI commands (#198).
 */

import {
  CHANGELOG_OWN_FLAGS,
  CONFIG_TELEMETRY_FLAGS,
  DIFF_OWN_FLAGS,
  DOCS_OWN_FLAGS,
  INIT_OWN_FLAGS,
  LINT_OWN_FLAGS,
  RUNNER_REGISTER_FLAGS,
  SCAN_OWN_FLAGS,
  SKILL_OWN_FLAGS,
  VERIFY_OWN_FLAGS,
  WATCH_OWN_FLAGS,
} from './command-registry.command-flags';
import {
  COMMON_CONNECTION_FLAGS,
  COMMON_PRESENTATION_FLAGS,
  type ConnectionFlagKey,
  type PresentationFlagKey,
} from './command-registry.common-flags';
import type { CommandRegistry, CommandSpec, FlagSpec, OwnFlagKeys } from './command-registry.types';
import type { ScanFlags } from '../commands/scan';

const DEFAULT_TENANT_SPEC: Pick<CommandSpec, 'commonPresentation' | 'commonConnection'> = {
  commonPresentation: true,
  commonConnection: true,
};

export const COMMAND_REGISTRY = {
  scan: {
    summary:
      'Run the full test pipeline (fuzzing, validation, RBAC, rate limits, error codes, deprecation).',
    usage: 'dino scan --tenant <id> [--env <name>] [options]',
    ownFlags: SCAN_OWN_FLAGS,
    ...DEFAULT_TENANT_SPEC,
    effects: 'non_idempotent',
    exitCodes: [0, 2, 3, 4, 5, 6, 70],
    output: { format: 'json', schemaRef: 'DinoResultV1' },
  },
  watch: {
    summary: 'Run scheduled scans with Shadow Mode (observe or enforce).',
    usage: 'dino watch --tenant <id> [options]',
    ownFlags: WATCH_OWN_FLAGS,
    ...DEFAULT_TENANT_SPEC,
    effects: 'non_idempotent',
    exitCodes: [0, 2, 3, 4, 5, 6, 70],
    // watch prints per-iteration summaries; it never emits a result document (the DinoResult is scan's).
    output: { format: 'text' },
  },
  docs: {
    summary: 'Generate API documentation from your live API.',
    usage: 'dino docs --tenant <id> [--format <markdown|json>]',
    ownFlags: DOCS_OWN_FLAGS,
    ...DEFAULT_TENANT_SPEC,
    effects: 'read_only',
    exitCodes: [0, 2, 4, 5, 70],
    output: { format: 'markdown', schemaRef: 'CatalogReport' },
  },
  diff: {
    summary: 'Compare the current schema against a saved snapshot.',
    usage: 'dino diff --tenant <id> [options]',
    ownFlags: DIFF_OWN_FLAGS,
    ...DEFAULT_TENANT_SPEC,
    effects: 'read_only',
    exitCodes: [0, 2, 3, 4, 5, 70],
  },
  lint: {
    summary: 'Check schema descriptions (fails on new undocumented operations).',
    usage: 'dino lint --tenant <id> [options]',
    ownFlags: LINT_OWN_FLAGS,
    ...DEFAULT_TENANT_SPEC,
    effects: 'read_only',
    exitCodes: [0, 2, 3, 4, 5, 70],
  },
  changelog: {
    summary: 'Generate a changelog from schema snapshot diffs.',
    usage: 'dino changelog --tenant <id> [options]',
    ownFlags: CHANGELOG_OWN_FLAGS,
    ...DEFAULT_TENANT_SPEC,
    effects: 'read_only',
    exitCodes: [0, 2, 3, 4, 5, 70],
  },
  runner: {
    summary: 'Cloud runner: register this machine, then start polling for scan jobs.',
    usage: 'dino runner <register|start> [options]',
    ownFlags: RUNNER_REGISTER_FLAGS,
    commonPresentation: false,
    commonConnection: false,
    effects: 'non_idempotent',
    exitCodes: [0, 2, 70],
  },
  verify: {
    summary:
      "Verify a scan's result against its Sigstore attestation (requires --cloud-endpoint and --token).",
    usage: 'dino verify --cloud-endpoint <url> --token <token>',
    ownFlags: VERIFY_OWN_FLAGS,
    commonPresentation: false,
    commonConnection: false,
    effects: 'read_only',
    exitCodes: [0, 2, 70],
  },
  login: {
    summary:
      'Authenticate via browser (Connected Apps + PKCE); stores a token in ~/.dino/credentials.json.',
    usage: 'dino login [--api-url <url>]',
    ownFlags: {
      apiUrl: {
        name: '--api-url',
        arg: '<url>',
        type: 'string',
        description: 'Cloud API URL (optional override)',
      },
    },
    commonPresentation: false,
    commonConnection: false,
    effects: 'non_idempotent',
    exitCodes: [0, 2, 70],
  },
  logout: {
    summary: 'Clear stored credentials (best-effort server revoke).',
    usage: 'dino logout',
    ownFlags: {},
    commonPresentation: false,
    commonConnection: false,
    effects: 'non_idempotent',
    exitCodes: [0, 2, 70],
  },
  whoami: {
    summary: 'Show the active tenant for the current login.',
    usage: 'dino whoami',
    ownFlags: {},
    commonPresentation: false,
    commonConnection: false,
    effects: 'read_only',
    exitCodes: [0, 2, 70],
  },
  validate: {
    summary: 'Validate .dino.yml config (with helpful error messages).',
    usage: 'dino validate',
    ownFlags: {},
    commonPresentation: true,
    commonConnection: false,
    effects: 'read_only',
    exitCodes: [0, 2, 5, 70],
  },
  init: {
    summary: 'Set up your project: generates .dino.yml interactively or headlessly for agents/CI.',
    usage:
      'dino init [--yes] [--force] [--dry-run] [--format json] [--endpoint URL] [--protocol graphql|rest] [--auth none|header|oauth2] …',
    ownFlags: INIT_OWN_FLAGS,
    commonPresentation: false,
    commonConnection: false,
    effects: 'non_idempotent',
    exitCodes: [0, 2, 70],
  },
  skill: {
    summary:
      'Print the Dino CLI Agent Skill for your coding agent, or --install it to .claude/skills/dino/SKILL.md.',
    usage: 'dino skill [--install]',
    ownFlags: SKILL_OWN_FLAGS,
    commonPresentation: false,
    commonConnection: false,
    effects: 'non_idempotent',
    exitCodes: [0, 2, 70],
  },
  config: {
    summary: 'Configure CLI preferences (e.g. telemetry).',
    usage: 'dino config telemetry [off|crash|all]',
    ownFlags: CONFIG_TELEMETRY_FLAGS,
    commonPresentation: false,
    commonConnection: false,
    effects: 'non_idempotent',
    exitCodes: [0, 2, 70],
  },
  telemetry: {
    summary: 'Manage anonymous CLI usage telemetry (on by default; opt-out anytime).',
    usage: 'dino telemetry status|enable|disable',
    ownFlags: {},
    commonPresentation: false,
    commonConnection: false,
    effects: 'non_idempotent',
    exitCodes: [0, 2, 70],
  },
  schema: {
    summary: 'Print a clispec v0.3 JSON description of every command, flag, and exit code.',
    usage: 'dino schema',
    ownFlags: {},
    commonPresentation: false,
    commonConnection: false,
    effects: 'read_only',
    exitCodes: [0, 2],
    output: { format: 'json', schemaRef: 'clispec-v0.3' },
  },
} satisfies CommandRegistry;

/** Compile-time tie exports for tests (Gate 28). */
export type ScanRegistryOwnFlags = typeof SCAN_OWN_FLAGS;
export type WatchRegistryOwnFlags = typeof WATCH_OWN_FLAGS;

/** Merge registry flag sections for help rendering and schema emission. */
export function mergedFlagsForCommand(command: string): Record<string, FlagSpec> {
  const spec = COMMAND_REGISTRY[command as keyof typeof COMMAND_REGISTRY];
  if (!spec) return {};
  return {
    ...(spec.commonConnection ? COMMON_CONNECTION_FLAGS : {}),
    ...(spec.commonPresentation ? COMMON_PRESENTATION_FLAGS : {}),
    ...spec.ownFlags,
  };
}

export function listRegistryCommands(): string[] {
  return Object.keys(COMMAND_REGISTRY).sort((a, b) => a.localeCompare(b));
}

export function getCommandSpec(command: string): CommandSpec | undefined {
  return COMMAND_REGISTRY[command as keyof typeof COMMAND_REGISTRY];
}

/** Type-level coverage: only compiles when scan own-flags match ScanFlags (minus auth). */
export type ScanOwnFlagCoverage = Record<Exclude<OwnFlagKeys<ScanFlags>, 'auth'>, FlagSpec>;
export const SCAN_OWN_FLAG_COVERAGE: ScanOwnFlagCoverage = SCAN_OWN_FLAGS;

export type CommonPresentationCoverage = Record<PresentationFlagKey, FlagSpec>;
export const COMMON_PRESENTATION_COVERAGE: CommonPresentationCoverage = COMMON_PRESENTATION_FLAGS;

export type CommonConnectionCoverage = Record<ConnectionFlagKey, FlagSpec>;
export const COMMON_CONNECTION_COVERAGE: CommonConnectionCoverage = COMMON_CONNECTION_FLAGS;

export {
  COMMON_CONNECTION_FLAGS,
  COMMON_PRESENTATION_FLAGS,
} from './command-registry.common-flags';
export { SCAN_OWN_FLAGS, WATCH_OWN_FLAGS } from './command-registry.command-flags';
export type { CommandSpec, FlagSpec, CommandRegistry, OwnFlagKeys } from './command-registry.types';
