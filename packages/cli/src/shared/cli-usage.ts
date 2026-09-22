/**
 * Top-level CLI usage / quickstart copy (#2160, #198 registry-driven).
 */

import { flagNameAndArg, formatFlagLineColumnar } from './command-help';
import {
  COMMAND_REGISTRY,
  COMMON_PRESENTATION_FLAGS,
  listRegistryCommands,
} from './command-registry';
import { CLI_VERSION } from '../version';

function commandListLines(): string[] {
  return listRegistryCommands().map((name) => {
    const spec = COMMAND_REGISTRY[name as keyof typeof COMMAND_REGISTRY];
    return `  ${name.padEnd(10)} ${spec.summary}`;
  });
}

function formatMetaOption(names: string, description: string, nameArgColumnWidth: number): string {
  const padding = Math.max(2, nameArgColumnWidth - names.length);
  return `${names}${' '.repeat(padding)}${description}`;
}

function usageCommonOptionsSection(): string[] {
  const specs = Object.values(COMMON_PRESENTATION_FLAGS);
  const nameArgColumnWidth = Math.max(...specs.map((spec) => flagNameAndArg(spec).length));
  const registryLines = specs.map(
    (spec) => `  ${formatFlagLineColumnar(spec, nameArgColumnWidth)}`,
  );
  return [
    'Common options:',
    ...registryLines,
    `  ${formatMetaOption('--help, -h', 'Show this help message', nameArgColumnWidth)}`,
    `  ${formatMetaOption('--version, -v', 'Show version number', nameArgColumnWidth)}`,
  ];
}

function usageTelemetrySection(): string[] {
  return [
    'Telemetry (anonymous, opt-out):',
    '  dino telemetry status|enable|disable',
    '  DINO_TELEMETRY_DISABLED=1  Disable telemetry (same as disable)',
    '  DO_NOT_TRACK=1             Industry-standard opt-out',
    '  DINO_TELEMETRY_DEBUG=1     Print payloads to stderr (no network send)',
  ];
}

function usageOptionsPointerSection(): string[] {
  return [
    'More options:',
    '  dino <command> --help    Per-command flags (registry-driven)',
    '  dino schema              Machine-readable clispec v0.3 contract (offline)',
  ];
}

/** Full usage for explicit `dino --help`. */
export function usageText(): string {
  const lines = [
    `dino v${CLI_VERSION}: the deterministic verification layer for APIs`,
    '',
    'Usage: dino <command> [options]',
    '',
    'Commands:',
    ...commandListLines(),
    '',
    ...usageCommonOptionsSection(),
    '',
    ...usageTelemetrySection(),
    '',
    ...usageOptionsPointerSection(),
  ];
  return lines.join('\n');
}

/** #2160: bare `dino` prints a short quickstart, not the full command dump. */
export function quickstartText(): string {
  return `dino v${CLI_VERSION}: the deterministic verification layer for APIs

Get started:
  dino scan --endpoint <url>
  dino init
  dino --help
`;
}
