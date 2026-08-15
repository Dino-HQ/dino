/**
 * Translate a core safePath traversal Error (user-supplied path) into a usage CliError.
 * Does NOT change core safePath; internal callers keep using safePath directly.
 */

import { safePath } from '@dino/core';
import { CliError } from './errors';

/** Translate a core safePath traversal Error (user-supplied path) into a usage CliError. */
export function safeUserPath(userPath: string, flag: string, allowedRoot?: string): string {
  try {
    return safePath(userPath, allowedRoot);
  } catch (err) {
    throw new CliError(
      `${flag} path is outside the working directory.`,
      2,
      'Use a path inside the current project directory.',
      err,
      'usage',
    );
  }
}
