/**
 * @dino/cli — dino validate (.dino.yml validation against schema)
 * Issue #558, #1013, #1014. INV-4: No tenant config loading or network calls.
 */

import { loadCliConfig } from '../config/loader';
import { shouldRenderInkView } from '../ink/InkRender';
import { emitResult } from '../shared/emit-result';
import { reportCaughtFailure } from '../shared/report-failure';
import { detectUi, createSpinner, printNotice } from '../shared/ui';
import { CLI_VERSION } from '../version';
import type { UiOptions } from '../shared/ui';

export interface ValidateFlags {
  quiet?: boolean;
  noColor?: boolean;
}

async function showValidateResult(
  message: string,
  ui: UiOptions,
  flags: ValidateFlags,
): Promise<void> {
  if (flags.quiet) return;
  let inkShown = false;
  if (shouldRenderInkView(ui, { quiet: flags.quiet })) {
    try {
      const React = await import('react');
      const { renderViewSafe } = await import('../ink/InkRender');
      const { ValidateView } = await import('../views/ValidateView');
      inkShown = renderViewSafe(
        React.createElement(ValidateView, {
          version: CLI_VERSION,
          success: true,
          message,
          colored: ui.colored,
        }),
      );
    } catch (error_) {
      console.warn(
        '[dino] Ink validate view failed:',
        error_ instanceof Error ? error_.message : String(error_),
      );
    }
  }
  if (!inkShown) {
    // #175: next-step is chrome → stderr
    printNotice('Next: run dino scan to check your API.', ui);
  }
}

/**
 * dino validate
 *
 * Validates .dino.yml against the Zod schema (same schema as loadCliConfig).
 * Prints field-level errors. Exit 0 = valid; an invalid config exits 5 (config)
 * with a stderr JSON envelope via the canonical failure emitter (#348).
 *
 * INV-2: Uses the same Zod schema as loadCliConfig() — no second source of truth.
 * INV-4: Does NOT load tenant config or make network calls.
 */
export async function runValidate(_context: unknown, flags: ValidateFlags): Promise<number> {
  const ui = detectUi(flags);
  const spinner = createSpinner('Validating config…', ui);
  spinner.start();

  try {
    const config = await loadCliConfig();
    if (!config) {
      const message = 'No .dino.yml found - using smart defaults. Config is valid.';
      spinner.succeed(message);
      // #2172: validate result is a stdout document (clig.dev); chrome stays on stderr
      emitResult(message);
      await showValidateResult(message, ui, flags);
      return 0;
    }
    const message = '.dino.yml is valid';
    spinner.succeed(message);
    emitResult(message);
    await showValidateResult(message, ui, flags);
    return 0;
  } catch (err) {
    spinner.fail('Config invalid');
    // #348: an invalid .dino.yml is a config error (exit 5 + stderr envelope), not a bare 1.
    // loadCliConfig already throws CliError(kind:'config'); route it through the canonical
    // emitter so validate matches `dino scan` and every other command (single source of truth).
    return reportCaughtFailure(err, { noColor: flags.noColor === true });
  }
}
