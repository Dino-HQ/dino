/**
 * @dino/cli — dino validate (.dino.yml validation against schema)
 * Issue #558, #1013, #1014. INV-4: No tenant config loading or network calls.
 */

import { loadCliConfig } from '../config/loader';
import { shouldRenderInkView } from '../ink/InkRender';
import { detectUi, colorize, createSpinner } from '../shared/ui';
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
    console.info(colorize('Next: run dino scan to check your API.', 'dim', ui));
  }
}

/**
 * dino validate
 *
 * Validates .dino.yml against the Zod schema (same schema as loadCliConfig).
 * Prints field-level errors. Exit 0 = valid, exit 1 = invalid.
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
      spinner.succeed('No .dino.yml found — using smart defaults. Config is valid.');
      await showValidateResult('No .dino.yml — smart defaults. Config is valid.', ui, flags);
      return 0;
    }
    spinner.succeed('.dino.yml is valid');
    await showValidateResult('.dino.yml is valid', ui, flags);
    return 0;
  } catch (err) {
    spinner.fail('Config invalid');
    if (err instanceof Error) {
      console.error(colorize(`✗ ${err.message}`, 'red', ui));
    } else {
      console.error(colorize(`✗ Config validation failed: ${String(err)}`, 'red', ui));
    }
    return 1;
  }
}
