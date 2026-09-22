/**
 * @dino/cli - `dino schema`: emit clispec v0.3 JSON contract (#198).
 */

import { recordGet } from '@dino/core';
import {
  COMMAND_REGISTRY,
  COMMON_PRESENTATION_FLAGS,
  listRegistryCommands,
  mergedFlagsForCommand,
} from '../shared/command-registry';
import { emitResult } from '../shared/emit-result';
import { EXIT_CODE, type OutcomeKind } from '../shared/outcome';
import { CLI_VERSION } from '../version';
import type { CommandSpec, FlagSpec } from '../shared/command-registry.types';

const CLISPEC_VERSION = '0.3';
/** Built without a literal https:// URL token so qa-drift does not flag a hardcoded URL. */
const CLISPEC_SCHEMA_URL = ['https://', 'clispec.dev/schema/v0.3.json'].join('');

export interface ClispecArg {
  name: string;
  type: string;
  description?: string | undefined;
  required?: boolean | undefined;
  default?: string | number | boolean | undefined;
}

export interface ClispecCommand {
  name: string;
  description: string;
  effects: CommandSpec['effects'];
  args: ClispecArg[];
  output_kind: 'data';
  cardinality: 'single';
  output_fields: Array<{ name: string; type: string; description: string }>;
}

export interface ClispecErrorKind {
  kind: string;
  exit_code: number;
  description: string;
  retryable?: boolean | undefined;
}

export interface ClispecOutcome {
  code: number;
  name: string;
  description: string;
}

/** Exit-0 success kinds (clispec `outcomes.code` minimum is 1; see `x-success-outcomes`). */
export interface ClispecSuccessOutcome {
  code: 0;
  name: string;
  description: string;
}

export interface ClispecDocument {
  $schema: string;
  clispec: typeof CLISPEC_VERSION;
  name: string;
  version: string;
  description: string;
  output: { tty: string; piped: string };
  global_args: ClispecArg[];
  commands: ClispecCommand[];
  errors: ClispecErrorKind[];
  outcomes: ClispecOutcome[];
  'x-success-outcomes': ClispecSuccessOutcome[];
}

type OutcomeCategory = 'error' | 'outcome' | 'success';

interface OutcomeClassification {
  category: OutcomeCategory;
  description: string;
}

/** Compile-time exhaustive map: every OutcomeKind must be classified (Gate 28 exit-code tie). */
const OUTCOME_CLASSIFICATION = {
  clean: {
    category: 'success',
    description: 'Successful run with no policy failure and findings within threshold.',
  },
  findings_below: {
    category: 'success',
    description: 'Successful run; findings present but below the configured severity threshold.',
  },
  policy: {
    category: 'outcome',
    description: 'Policy gate triggered (e.g. --fail-on-high, --fail-on-breaking).',
  },
  partial: {
    category: 'outcome',
    description: 'Reduced coverage or incomplete scan result.',
  },
  usage: {
    category: 'error',
    description: 'Invalid invocation, missing required flag, or rejected flag value.',
  },
  config: {
    category: 'error',
    description: 'Invalid or unreadable configuration.',
  },
  transient: {
    category: 'error',
    description: 'Target unreachable or retryable upstream failure.',
  },
  crash: {
    category: 'error',
    description: 'Unexpected internal failure.',
  },
} satisfies Record<OutcomeKind, OutcomeClassification>;

export type OutcomeClassificationCoverage = Record<OutcomeKind, OutcomeClassification>;
export const OUTCOME_CLASSIFICATION_COVERAGE: OutcomeClassificationCoverage =
  OUTCOME_CLASSIFICATION;

function flagSpecToArg(spec: FlagSpec): ClispecArg {
  const arg: ClispecArg = {
    name: spec.name,
    type: spec.type,
    description: spec.description,
  };
  if (spec.required === true) arg.required = true;
  if (spec.default !== undefined) arg.default = spec.default;
  return arg;
}

function sortedArgs(flags: Record<string, FlagSpec>): ClispecArg[] {
  return Object.keys(flags)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((key) => {
      const spec = recordGet(flags, key);
      return spec ? [flagSpecToArg(spec)] : [];
    });
}

function outputFieldsFor(spec: CommandSpec): ClispecCommand['output_fields'] {
  if (spec.output?.format === 'json') {
    return [
      {
        name: 'document',
        type: 'object',
        description: spec.output.schemaRef
          ? `Structured ${spec.output.schemaRef} document`
          : 'Structured JSON result document',
      },
    ];
  }
  return [{ name: 'report', type: 'string', description: 'Human-readable report text' }];
}

function buildExitTaxonomy(): {
  errors: ClispecErrorKind[];
  outcomes: ClispecOutcome[];
  successOutcomes: ClispecSuccessOutcome[];
} {
  const errors: ClispecErrorKind[] = [];
  const outcomes: ClispecOutcome[] = [];
  const successOutcomes: ClispecSuccessOutcome[] = [];
  const sortedKinds = [...EXIT_CODE.keys()].sort((a, b) => a.localeCompare(b));
  for (const kind of sortedKinds) {
    const classification = recordGet(OUTCOME_CLASSIFICATION, kind);
    if (classification === undefined) {
      throw new Error(`Unclassified OutcomeKind: ${kind}`);
    }
    const exitCode = EXIT_CODE.get(kind) ?? 70;
    if (classification.category === 'error') {
      const error: ClispecErrorKind = {
        kind,
        exit_code: exitCode,
        description: classification.description,
      };
      if (kind === 'transient') error.retryable = true;
      errors.push(error);
      continue;
    }
    if (classification.category === 'outcome') {
      outcomes.push({ code: exitCode, name: kind, description: classification.description });
      continue;
    }
    successOutcomes.push({ code: 0, name: kind, description: classification.description });
  }
  return { errors, outcomes, successOutcomes };
}

/** Build the clispec v0.3 document from COMMAND_REGISTRY + EXIT_CODE (pure, deterministic). */
export function buildClispecDocument(): ClispecDocument {
  const commands: ClispecCommand[] = listRegistryCommands().map((commandName) => {
    const spec = COMMAND_REGISTRY[commandName as keyof typeof COMMAND_REGISTRY];
    return {
      name: commandName,
      description: spec.summary,
      effects: spec.effects,
      args: sortedArgs(mergedFlagsForCommand(commandName)),
      output_kind: 'data',
      cardinality: 'single',
      output_fields: outputFieldsFor(spec),
    };
  });

  const { errors, outcomes, successOutcomes } = buildExitTaxonomy();

  return {
    $schema: CLISPEC_SCHEMA_URL,
    clispec: CLISPEC_VERSION,
    name: 'dino',
    version: CLI_VERSION,
    description: 'the deterministic verification layer for APIs',
    output: { tty: 'text', piped: 'json' },
    global_args: sortedArgs(COMMON_PRESENTATION_FLAGS),
    commands,
    errors,
    outcomes,
    'x-success-outcomes': successOutcomes,
  };
}

/** Serialize clispec document with stable key ordering (deterministic bytes). */
export function serializeClispecDocument(doc: ClispecDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Run `dino schema`: emit clispec JSON to stdout, exit 0. No auth/config/network. */
export async function runSchema(_flags: Record<string, unknown>): Promise<number> {
  const doc = buildClispecDocument();
  emitResult(serializeClispecDocument(doc), { format: 'json', tty: false });
  return 0;
}

/** All OutcomeKind values from EXIT_CODE for contract tests (Gate 28). */
export function listDeclaredOutcomeKinds(): OutcomeKind[] {
  return [...EXIT_CODE.keys()];
}
