/**
 * @dino/cli — dino validate (.dino.yml validation against schema)
 * Issue #558. INV-4: No tenant config loading or network calls.
 */

import { loadCliConfig } from '../config/loader';

export interface ValidateFlags {
  quiet?: boolean;
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
  try {
    const config = await loadCliConfig();
    if (!config) {
      if (!flags.quiet) {
        console.info('No .dino.yml found — using smart defaults. Config is valid.');
      }
      return 0;
    }
    if (!flags.quiet) {
      console.info('✓ .dino.yml is valid.');
    }
    return 0;
  } catch (err) {
    if (err instanceof Error) {
      console.error(`✗ ${err.message}`);
    } else {
      console.error('✗ Config validation failed:', String(err));
    }
    return 1;
  }
}
