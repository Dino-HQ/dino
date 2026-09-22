/**
 * Per-command help for `dino <command> --help` (#2141, #198 registry-driven).
 */
import { recordGet } from '@dino/core';
import { COMMAND_REGISTRY, mergedFlagsForCommand } from './command-registry';
import { emitResult } from './emit-result';
import type { FlagSpec } from './command-registry.types';

const COMMON_OPTIONS_HINT =
  'Common options: --tenant <id>  --env <name>  --format <markdown|json>  --quiet  --verbose  --debug  --no-color';

export function flagNameAndArg(spec: FlagSpec): string {
  const argPart = spec.arg ? ` ${spec.arg}` : '';
  return `${spec.name}${argPart}`;
}

export function formatFlagLine(spec: FlagSpec): string {
  return `${flagNameAndArg(spec)}  ${spec.description}`;
}

/** Column-aligned variant for top-level usage (same name/arg/description as formatFlagLine). */
export function formatFlagLineColumnar(spec: FlagSpec, nameArgColumnWidth: number): string {
  const left = flagNameAndArg(spec);
  const padding = Math.max(2, nameArgColumnWidth - left.length);
  return `${left}${' '.repeat(padding)}${spec.description}`;
}

function formatOptions(flags: Record<string, FlagSpec>): string[] {
  return Object.keys(flags)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((key) => {
      const spec = recordGet(flags, key);
      return spec ? [formatFlagLine(spec)] : [];
    });
}

/** Print help for a single command. Returns true if `command` was a known command. */
export function printCommandHelp(command: string): boolean {
  const help = recordGet(COMMAND_REGISTRY, command);
  if (!help) return false;
  const flagMap = mergedFlagsForCommand(command);
  const optionLines = formatOptions(flagMap);
  const lines = [`dino ${command}: ${help.summary}`, '', `Usage: ${help.usage}`];
  if (optionLines.length > 0) {
    lines.push('', 'Options:', ...optionLines.map((o) => `  ${o}`));
  }
  if (help.commonPresentation !== false) {
    lines.push('', COMMON_OPTIONS_HINT);
  }
  emitResult(lines.join('\n'));
  return true;
}
