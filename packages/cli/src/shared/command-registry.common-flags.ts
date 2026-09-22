/**
 * @dino/cli - shared connection/presentation flags for COMMAND_REGISTRY (#198).
 */

import type { FlagSpec } from './command-registry.types';

export type ConnectionFlagKey =
  | 'endpoint'
  | 'protocol'
  | 'specUrl'
  | 'header'
  | 'token'
  | 'allowPrivateTarget';
export type PresentationFlagKey =
  | 'tenant'
  | 'env'
  | 'format'
  | 'quiet'
  | 'verbose'
  | 'debug'
  | 'noColor';

export const COMMON_CONNECTION_FLAGS = {
  endpoint: {
    name: '--endpoint',
    arg: '<url>',
    type: 'string',
    description: 'Ad-hoc scan target (no .dino.yml needed)',
  },
  protocol: {
    name: '--protocol',
    arg: '<type>',
    type: 'string',
    description: 'graphql (default) | rest',
  },
  specUrl: {
    name: '--spec-url',
    arg: '<url|path>',
    type: 'string',
    description: 'OpenAPI spec URL or path (required when --protocol rest)',
  },
  header: {
    name: '--header',
    arg: '"Name: Value"',
    type: 'string[]',
    repeatable: true,
    description: 'Send a static auth header (repeatable)',
  },
  token: {
    name: '--token',
    arg: '<token>',
    type: 'string',
    description: 'Shortcut for --header "Authorization: Bearer <token>"',
  },
  allowPrivateTarget: {
    name: '--allow-private-target',
    type: 'boolean',
    description: 'Permit a loopback or private-network target (never link-local or metadata)',
  },
} satisfies Record<ConnectionFlagKey, FlagSpec>;

export const COMMON_PRESENTATION_FLAGS = {
  tenant: {
    name: '--tenant',
    arg: '<id>',
    type: 'string',
    description: 'Tenant config to use (or --endpoint for an ad-hoc scan)',
  },
  env: {
    name: '--env',
    arg: '<name>',
    type: 'string',
    description: "Target environment (default: tenant's default)",
  },
  format: {
    name: '--format',
    arg: '<markdown|json>',
    type: 'string',
    description: 'Output format: markdown | json',
  },
  quiet: {
    name: '--quiet',
    type: 'boolean',
    description: 'Suppress non-essential output',
  },
  verbose: {
    name: '--verbose',
    type: 'boolean',
    description: 'Show applied defaults and internal diagnostics',
  },
  debug: {
    name: '--debug',
    type: 'boolean',
    description: 'Show full stack traces on errors',
  },
  noColor: {
    name: '--no-color',
    type: 'boolean',
    description: 'Disable all color output (also respects NO_COLOR env var)',
  },
} satisfies Record<PresentationFlagKey, FlagSpec>;
