/**
 * @dino/cli - per-command own-flag specs for COMMAND_REGISTRY (#198).
 */

import type { FlagSpec, OwnFlagKeys } from './command-registry.types';
import type { ChangelogFlags } from '../commands/changelog';
import type { DiffFlags } from '../commands/diff';
import type { DocsFlags } from '../commands/docs';
import type { LintFlags } from '../commands/lint';
import type { ScanFlags } from '../commands/scan';
import type { WatchFlags } from '../commands/watch-helpers';

export const SCAN_OWN_FLAGS = {
  modules: {
    name: '--modules',
    arg: '<list>',
    type: 'string[]',
    description: 'Comma-separated modules to scan (default: all)',
  },
  tools: {
    name: '--tools',
    arg: '<list>',
    type: 'string[]',
    description: 'Comma-separated tools to run (default: all)',
  },
  timeout: {
    name: '--timeout',
    arg: '<ms>',
    type: 'number',
    description: 'Per-request timeout in milliseconds',
  },
  snapshotDir: {
    name: '--snapshot-dir',
    arg: '<path>',
    type: 'string',
    description: 'Directory for catalog snapshots',
  },
  failOnHigh: {
    name: '--fail-on-high',
    type: 'boolean',
    description: 'Exit 3 if HIGH or CRITICAL findings exist',
  },
  acceptPartial: {
    name: '--accept-partial',
    type: 'boolean',
    description: 'Treat a reduced-coverage (partial) scan as success: exit 0 instead of 6',
  },
  burst: {
    name: '--burst',
    arg: '<n>',
    type: 'number',
    description: 'Requests per rate-limit burst (default 61; one past a 60/min limit, the smallest burst that can disprove one)',
  },
} satisfies Record<Exclude<OwnFlagKeys<ScanFlags>, 'auth'>, FlagSpec>;

export const WATCH_OWN_FLAGS = {
  interval: {
    name: '--interval',
    arg: '<sec>',
    type: 'number',
    description: 'Seconds between scans (default: 300)',
  },
  iterations: {
    name: '--iterations',
    arg: '<n>',
    type: 'number',
    description: 'Maximum number of scan iterations',
  },
  once: {
    name: '--once',
    type: 'boolean',
    description: 'Run a single scan and exit (alias for --iterations 1)',
  },
  autonomy: {
    name: '--autonomy',
    arg: '<mode>',
    type: 'string',
    description: 'Shadow Mode: observe (default) or enforce',
  },
  historyLimit: {
    name: '--history-limit',
    arg: '<n>',
    type: 'number',
    description: 'Maximum watch history entries to retain',
  },
  snapshotDir: {
    name: '--snapshot-dir',
    arg: '<path>',
    type: 'string',
    description: 'Directory for catalog snapshots',
  },
  tools: {
    name: '--tools',
    arg: '<list>',
    type: 'string[]',
    description: 'Comma-separated tools to run (default: all)',
  },
  modules: {
    name: '--modules',
    arg: '<list>',
    type: 'string[]',
    description: 'Comma-separated modules to scan (default: all)',
  },
  timeout: {
    name: '--timeout',
    arg: '<ms>',
    type: 'number',
    description: 'Per-request timeout in milliseconds',
  },
  maxConsecutiveFailures: {
    name: '--max-consecutive-failures',
    arg: '<n>',
    type: 'number',
    description: 'Stop watch after this many consecutive failed iterations',
  },
} satisfies Record<Exclude<OwnFlagKeys<WatchFlags>, 'auth'>, FlagSpec>;

export const DOCS_OWN_FLAGS = {
  output: {
    name: '--output',
    arg: '<path>',
    type: 'string',
    description: 'Write documentation to a file instead of stdout',
  },
  title: {
    name: '--title',
    arg: '<text>',
    type: 'string',
    description: 'Report title (markdown/json output)',
  },
  ai: {
    name: '--ai',
    type: 'boolean',
    description: 'Deprecated: has no effect (the CLI runs no AI) and will be removed in a future major version',
  },
  threshold: {
    name: '--threshold',
    arg: '<n>',
    type: 'number',
    description: 'Health score threshold for highlighting in the report',
  },
} satisfies Record<OwnFlagKeys<DocsFlags>, FlagSpec>;

export const DIFF_OWN_FLAGS = {
  snapshotDir: {
    name: '--snapshot-dir',
    arg: '<path>',
    type: 'string',
    description: 'Directory containing schema snapshots',
  },
  failOnBreaking: {
    name: '--fail-on-breaking',
    type: 'boolean',
    description: 'Exit 3 if breaking changes are detected',
  },
} satisfies Record<OwnFlagKeys<DiffFlags>, FlagSpec>;

export const LINT_OWN_FLAGS = {
  snapshotDir: {
    name: '--snapshot-dir',
    arg: '<path>',
    type: 'string',
    description: 'Directory containing schema snapshots',
  },
  failOnUndocumented: {
    name: '--fail-on-undocumented',
    type: 'boolean',
    description: 'Exit 3 if new undocumented operations are found',
  },
} satisfies Record<OwnFlagKeys<LintFlags>, FlagSpec>;

export const CHANGELOG_OWN_FLAGS = {
  snapshotDir: {
    name: '--snapshot-dir',
    arg: '<path>',
    type: 'string',
    description: 'Directory containing schema snapshots',
  },
  failOnBreaking: {
    name: '--fail-on-breaking',
    type: 'boolean',
    description: 'Exit 3 if breaking changes are detected',
  },
  from: {
    name: '--from',
    arg: '<id>',
    type: 'string',
    description: 'Compare against a specific snapshot ID',
  },
} satisfies Record<OwnFlagKeys<ChangelogFlags>, FlagSpec>;

/** Init CLI flags (headless + interactive); not tied to InitFlags internal fields. */
export const INIT_OWN_FLAGS = {
  yes: {
    name: '--yes',
    type: 'boolean',
    description: 'Force non-interactive mode (no prompts)',
  },
  dryRun: {
    name: '--dry-run',
    type: 'boolean',
    description: 'Preview config without writing',
  },
  format: {
    name: '--format',
    arg: 'json',
    type: 'string',
    description: 'Machine-readable result document on stdout (json)',
  },
  force: {
    name: '--force',
    type: 'boolean',
    description: 'Overwrite an existing .dino.yml that differs',
  },
  endpoint: {
    name: '--endpoint',
    arg: 'URL',
    type: 'string',
    description: 'API endpoint (required in non-interactive mode)',
  },
  protocol: {
    name: '--protocol',
    arg: 'graphql|rest',
    type: 'string',
    description: 'Protocol (required in non-interactive mode)',
  },
  specUrl: {
    name: '--spec-url',
    arg: 'URL',
    type: 'string',
    description: 'OpenAPI spec URL/path (required when protocol=rest)',
  },
  auth: {
    name: '--auth',
    arg: 'none|header|oauth2',
    type: 'string',
    description: 'Auth mode (required in non-interactive mode)',
  },
  authHeader: {
    name: '--auth-header',
    arg: 'NAME',
    type: 'string',
    description: 'HTTP header name (required when auth=header)',
  },
  authScheme: {
    name: '--auth-scheme',
    arg: 'TOKEN',
    type: 'string',
    description: 'Header scheme e.g. Bearer (optional)',
  },
  authValueEnv: {
    name: '--auth-value-env',
    arg: 'VAR',
    type: 'string',
    description:
      'Env var holding the token (required when auth=header; NAME only, never a secret value)',
  },
  oauth2TokenEndpoint: {
    name: '--oauth2-token-endpoint',
    arg: 'URL',
    type: 'string',
    description: 'Token endpoint (required when auth=oauth2)',
  },
  oauth2ClientIdEnv: {
    name: '--oauth2-client-id-env',
    arg: 'VAR',
    type: 'string',
    description: 'Client id env var (required when auth=oauth2)',
  },
  oauth2ClientSecretEnv: {
    name: '--oauth2-client-secret-env',
    arg: 'VAR',
    type: 'string',
    description:
      'Client secret env var (required when auth=oauth2; NAME only, never a secret value)',
  },
  oauth2Scope: {
    name: '--oauth2-scope',
    arg: 'SCOPE',
    type: 'string',
    description: 'OAuth2 scope (optional)',
  },
} satisfies Record<string, FlagSpec>;

export const SKILL_OWN_FLAGS = {
  install: {
    name: '--install',
    type: 'boolean',
    description: 'Write the skill to .claude/skills/dino/SKILL.md',
  },
} satisfies Record<string, FlagSpec>;

export const VERIFY_OWN_FLAGS = {
  cloudEndpoint: {
    name: '--cloud-endpoint',
    arg: '<url>',
    type: 'string',
    description: 'Cloud API base URL for attestation verification',
  },
  token: {
    name: '--token',
    arg: '<token>',
    type: 'string',
    description: 'Bearer token for cloud API (prefer env var, never commit secrets)',
  },
} satisfies Record<string, FlagSpec>;

export const RUNNER_REGISTER_FLAGS = {
  apiUrl: {
    name: '--api-url',
    arg: '<url>',
    type: 'string',
    description: 'Cloud API URL for runner registration',
  },
  token: {
    name: '--token',
    arg: '<token>',
    type: 'string',
    description: 'Registration token (prefer env var, never commit secrets)',
  },
  attestationIdentity: {
    name: '--attestation-identity',
    arg: '<uri>',
    type: 'string',
    description: 'GitHub Actions workflow identity URI this runner signs attestations with (pinned by dino verify)',
  },
} satisfies Record<string, FlagSpec>;

export const CONFIG_TELEMETRY_FLAGS = {
  level: {
    name: 'telemetry',
    arg: '[off|crash|all]',
    type: 'string',
    description: 'Set telemetry level (omit to show current level)',
  },
} satisfies Record<string, FlagSpec>;
