/**
 * @dino/cli - typed command registry (#198). Single source of truth for flags, help, and schema.
 */

import type { CommonFlags } from './base-command';

/** Strip `[key: string]: unknown` index signatures before keyof. */
export type RemoveIndex<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/** Per-command flag keys: own fields only, excluding CommonFlags keys. */
export type OwnFlagKeys<T> = Exclude<keyof RemoveIndex<T>, keyof RemoveIndex<CommonFlags>>;

export type FlagValueType = 'string' | 'number' | 'boolean' | 'string[]';

export interface FlagSpec {
  /** Display name in `--kebab-case` form. Record key is the camelCase interface field. */
  name: string;
  arg?: string | undefined;
  type: FlagValueType;
  required?: boolean | undefined;
  default?: string | number | boolean | undefined;
  description: string;
  repeatable?: boolean | undefined;
}

export type CommandEffects = 'read_only' | 'idempotent' | 'non_idempotent';

export interface CommandOutputSpec {
  format: 'json' | 'markdown' | 'text';
  schemaRef?: string | undefined;
}

export interface CommandSpec {
  summary: string;
  usage: string;
  ownFlags: Record<string, FlagSpec>;
  /** Include shared presentation flags (tenant, format, quiet, ...). Default true. */
  commonPresentation?: boolean | undefined;
  /** Include ad-hoc connection flags (endpoint, protocol, spec-url, header, token). Default false. */
  commonConnection?: boolean | undefined;
  effects: CommandEffects;
  /** Declared exit codes this command may return (subset of EXIT_CODE values). */
  exitCodes: number[];
  output?: CommandOutputSpec | undefined;
}

export type CommandRegistry = Readonly<Record<string, CommandSpec>>;
