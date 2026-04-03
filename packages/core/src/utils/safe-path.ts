/**
 * Project Dino — Safe path resolution (Batch 9 — #448, #449, #470, #478)
 *
 * Validates that a user-supplied path resolves within an allowed root directory.
 * Prevents path traversal attacks via ../ or absolute paths outside root.
 */

import * as path from 'node:path';

/**
 * Validate that a user-supplied path resolves within an allowed root directory.
 * Prevents path traversal attacks via ../ or absolute paths outside root.
 *
 * @param userPath - User-supplied path (relative or absolute)
 * @param allowedRoot - Root directory (defaults to process.cwd())
 * @returns Resolved absolute path
 * @throws Error if resolved path escapes allowedRoot
 */
export function safePath(userPath: string, allowedRoot?: string): string {
  const root = allowedRoot ? path.resolve(allowedRoot) : process.cwd();
  const resolved = path.resolve(root, userPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path "${userPath}" resolves outside allowed directory "${root}"`);
  }
  return resolved;
}
