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
import * as path from 'node:path';
import { TenantConfigError } from '../tenant/tenant-config-error';
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

function symlinkEscape(filePath: string, root: string): TenantConfigError {
  return new TenantConfigError(
    `Path "${filePath}" resolves through a symlink to a location outside "${root}". Use a file inside that directory.`,
    'config',
  );
}

function isWithin(candidate: string, realRoot: string): boolean {
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return candidate === realRoot || candidate.startsWith(realRootWithSep);
}

/** Where the opened object actually lives. Linux reports it for the descriptor itself, so no swap can fool it. */
function openedPath(fd: number, resolved: string): { path: string; fromDescriptor: boolean } {
  try {
    return { path: fs.readlinkSync(`/proc/self/fd/${fd}`), fromDescriptor: true }; // eslint-disable-line security/detect-non-literal-fs-filename
  } catch {
    return { path: fs.realpathSync(resolved), fromDescriptor: false }; // eslint-disable-line security/detect-non-literal-fs-filename
  }
}

/**
 * Read a file that must physically live inside `root`, symlinks included (#2313).
 * The other wrappers check containment lexically only, so a symlink inside `root` can point
 * anywhere. Use this where `root` is a trust boundary distinct from the file (a config-declared
 * path under its config dir); elsewhere a lexical check keeps users' own symlinks working.
 * The file is opened first and the opened object is what gets checked and read, so swapping a
 * symlink in between cannot redirect the read.
 */
export function safeReadFileSyncContained(filePath: string, root: string): string {
  const resolved = safePath(filePath, root);
  const realRoot = fs.realpathSync(path.resolve(root)); // eslint-disable-line security/detect-non-literal-fs-filename
  const fd = fs.openSync(resolved, 'r'); // eslint-disable-line security/detect-non-literal-fs-filename
  try {
    const where = openedPath(fd, resolved);
    if (!isWithin(where.path, realRoot)) throw symlinkEscape(filePath, root);
    if (!where.fromDescriptor) {
      // Without a descriptor path, require the contained path to be the very object we opened.
      const opened = fs.fstatSync(fd);
      const atPath = fs.statSync(where.path); // eslint-disable-line security/detect-non-literal-fs-filename
      if (opened.dev !== atPath.dev || opened.ino !== atPath.ino) throw symlinkEscape(filePath, root);
    }
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
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
