/**
 * @dino/core — Safe filesystem wrappers.
 *
 * Every function validates the path stays within an allowed root before
 * performing the I/O operation.  This eliminates detect-non-literal-fs-filename
 * warnings at call sites because all dynamic fs access is centralized here.
 *
 * Call sites use these instead of raw fs.* calls with dynamic paths.
 */

import * as fs from 'node:fs';
import { safePath } from './safe-path';

// ---------------------------------------------------------------------------
// Sync wrappers
// ---------------------------------------------------------------------------

export function safeExistsSync(filePath: string, root: string): boolean {
  const resolved = safePath(filePath, root);
  return fs.existsSync(resolved); // eslint-disable-line security/detect-non-literal-fs-filename
}

export function safeReadFileSync(filePath: string, root: string): string {
  const resolved = safePath(filePath, root);
  return fs.readFileSync(resolved, 'utf-8'); // eslint-disable-line security/detect-non-literal-fs-filename
}

export function safeReaddirSync(
  dir: string,
  root: string,
  options?: { withFileTypes: true },
): fs.Dirent[] {
  const resolved = safePath(dir, root);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return fs.readdirSync(resolved, options ?? { withFileTypes: true });
}

export function safeMkdirSync(dir: string, root: string): void {
  const resolved = safePath(dir, root);
  fs.mkdirSync(resolved, { recursive: true }); // eslint-disable-line security/detect-non-literal-fs-filename
}

export function safeWriteFileSync(filePath: string, content: string, root: string): void {
  const resolved = safePath(filePath, root);
  fs.writeFileSync(resolved, content, 'utf-8'); // eslint-disable-line security/detect-non-literal-fs-filename
}

// ---------------------------------------------------------------------------
// Async wrappers
// ---------------------------------------------------------------------------

export async function safeMkdir(dir: string, root: string): Promise<void> {
  const resolved = safePath(dir, root);
  await fs.promises.mkdir(resolved, { recursive: true }); // eslint-disable-line security/detect-non-literal-fs-filename
}

export async function safeReadFile(filePath: string, root: string): Promise<string> {
  const resolved = safePath(filePath, root);
  return fs.promises.readFile(resolved, 'utf-8'); // eslint-disable-line security/detect-non-literal-fs-filename
}

export async function safeWriteFile(
  filePath: string,
  content: string,
  root: string,
): Promise<void> {
  const resolved = safePath(filePath, root);
  await fs.promises.writeFile(resolved, content, 'utf-8'); // eslint-disable-line security/detect-non-literal-fs-filename
}

export async function safeRename(oldPath: string, newPath: string, root: string): Promise<void> {
  const resolvedOld = safePath(oldPath, root);
  const resolvedNew = safePath(newPath, root);
  await fs.promises.rename(resolvedOld, resolvedNew); // eslint-disable-line security/detect-non-literal-fs-filename
}

export async function safeReaddir(dir: string, root: string): Promise<string[]> {
  const resolved = safePath(dir, root);
  return fs.promises.readdir(resolved); // eslint-disable-line security/detect-non-literal-fs-filename
}
