/**
 * #2198 — headless dino init write path (non-interactive orchestration).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildConfigYaml } from './config-yaml';
import { emitResult } from './emit-result';
import { CliError } from './errors';
import {
  buildInitResultDoc,
  gatherHeadlessInputs,
  resolveHeadlessInitAnswers,
  type InitResultDoc,
} from './init-headless';
import { boundErrorMessage } from './outcome';
import { detectUi, printNotice } from './ui';
import type { InitFlags } from '../commands/init';

function readExistingConfig(currentPath: string): string | null {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is always cwd/.dino.yml
  if (!existsSync(currentPath)) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is always cwd/.dino.yml
  return readFileSync(currentPath, 'utf-8');
}

function emitHeadlessJsonResult(doc: InitResultDoc): void {
  emitResult(buildInitResultDoc(doc), { format: 'json' });
}

interface HeadlessDryRunOptions {
  flags: InitFlags;
  ui: ReturnType<typeof detectUi>;
  answers: { endpoint: string; protocol: string };
  yaml: string;
  changed: boolean;
}

function finishHeadlessDryRun(options: HeadlessDryRunOptions): number {
  const { flags, ui, answers, yaml, changed } = options;
  if (flags.format === 'json') {
    emitHeadlessJsonResult({
      changed,
      dryRun: true,
      path: '.dino.yml',
      endpoint: answers.endpoint,
      protocol: answers.protocol,
      yaml,
    });
  } else {
    emitResult(yaml);
    printNotice('(dry run - no file written)', ui);
  }
  return 0;
}

function finishHeadlessUnchanged(
  flags: InitFlags,
  ui: ReturnType<typeof detectUi>,
  answers: { endpoint: string; protocol: string },
): number {
  if (flags.format === 'json') {
    emitHeadlessJsonResult({
      changed: false,
      path: '.dino.yml',
      endpoint: answers.endpoint,
      protocol: answers.protocol,
    });
  } else {
    printNotice('✔ .dino.yml already current', ui);
  }
  return 0;
}

function assertHeadlessOverwriteAllowed(current: string | null, force: boolean | undefined): void {
  if (current !== null && force !== true) {
    throw new CliError(
      '.dino.yml exists and differs; pass --force to overwrite',
      2,
      'Re-run with --force to overwrite the existing config.',
      undefined,
      'usage',
    );
  }
}

function writeHeadlessConfigOrThrow(configPath: string, yaml: string): void {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is always cwd/.dino.yml
    writeFileSync(configPath, yaml, 'utf-8');
  } catch (err) {
    throw new CliError(
      `Failed to write .dino.yml: ${boundErrorMessage(err)}`,
      70,
      'Check directory permissions and disk space.',
      err,
      'crash',
    );
  }
}

function finishHeadlessWritten(
  flags: InitFlags,
  ui: ReturnType<typeof detectUi>,
  answers: { endpoint: string; protocol: string },
): number {
  if (flags.format === 'json') {
    emitHeadlessJsonResult({
      changed: true,
      path: '.dino.yml',
      endpoint: answers.endpoint,
      protocol: answers.protocol,
    });
  } else {
    printNotice('✔ Created .dino.yml', ui);
  }
  return 0;
}

export async function runHeadlessInit(flags: InitFlags, configPath: string): Promise<number> {
  const ui = detectUi({ quiet: flags.quiet });
  const answers = resolveHeadlessInitAnswers(
    gatherHeadlessInputs(flags.rawFlags ?? {}, process.env),
  );
  const yaml = buildConfigYaml(answers);
  const current = readExistingConfig(configPath);
  const changed = current !== yaml;

  if (flags.dryRun === true) {
    return finishHeadlessDryRun({ flags, ui, answers, yaml, changed });
  }
  if (!changed) {
    return finishHeadlessUnchanged(flags, ui, answers);
  }
  assertHeadlessOverwriteAllowed(current, flags.force);
  writeHeadlessConfigOrThrow(configPath, yaml);
  return finishHeadlessWritten(flags, ui, answers);
}
