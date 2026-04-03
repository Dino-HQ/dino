/**
 * @dino/cli — Watch history persistence (Issue #309).
 * Stores run summaries at .dino/history/{tenantId}/{environment}/history.ndjson.
 *
 * B35 (#596): Switched from JSON array to NDJSON (one JSON object per line).
 * NDJSON is append-only — concurrent processes append without read-modify-write races.
 * Trimming to historyLimit rewrites the file, but data loss window is eliminated
 * because each line is independently valid.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { safeMkdir, safeReadFile, safeWriteFile, safeRename } from '@dino/core';
import { logger } from '../../../../src/utils/logger';

// B94 (#663): Zod schema for per-entry validation on load.
// Entries that don't match are silently filtered — old-format entries from
// before a schema change won't crash the loader.
const WatchHistoryEntrySchema = z.object({
  runId: z.string(),
  timestamp: z.string(),
  tenantId: z.string(),
  environment: z.string(),
  trigger: z.literal('watch'),
  durationMs: z.number(),
  operationCount: z.number(),
  toolsRun: z.number(),
  toolsCompleted: z.number(),
  toolsFailed: z.number(),
  degraded: z.boolean(),
  healthScore: z.number(),
  schemaChanges: z.object({
    added: z.number(),
    removed: z.number(),
    modified: z.number(),
    breakingChanges: z.number(),
  }),
  formatVersion: z.number().optional(),
});

export interface WatchHistoryEntry {
  /** Format version for forward compatibility (B91 #660) */
  formatVersion?: number;
  runId: string;
  timestamp: string;
  tenantId: string;
  environment: string;
  trigger: 'watch';
  durationMs: number;
  operationCount: number;
  toolsRun: number;
  toolsCompleted: number;
  toolsFailed: number;
  degraded: boolean;
  healthScore: number;
  schemaChanges: {
    added: number;
    removed: number;
    modified: number;
    breakingChanges: number;
  };
}

function resolveHistoryDir(historyDir: string, tenantId: string, environment: string): string {
  return path.join(historyDir, tenantId, environment);
}

function resolveFilepath(historyDir: string, tenantId: string, environment: string): string {
  return path.join(resolveHistoryDir(historyDir, tenantId, environment), 'history.ndjson');
}

/**
 * Migrate legacy history.json to history.ndjson if it exists.
 * Runs once per directory — after migration the .json file is removed.
 */
async function migrateLegacyIfNeeded(dir: string, historyDir: string): Promise<void> {
  const legacyPath = path.join(dir, 'history.json');
  try {
    const raw = await safeReadFile(legacyPath, historyDir);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const ndjson = parsed.map((e: unknown) => JSON.stringify(e)).join('\n') + '\n';
      const ndjsonPath = path.join(dir, 'history.ndjson');
      await safeWriteFile(ndjsonPath, ndjson, historyDir);
    }
    await fs.unlink(legacyPath).catch(() => {}); // eslint-disable-line security/detect-non-literal-fs-filename
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : '';
    const isNotFound =
      code === 'ENOENT' || (err instanceof Error && err.message.includes('ENOENT'));
    if (!isNotFound) {
      logger.warn('migrateLegacyIfNeeded: legacy migration failed', {
        legacyPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Append a history entry. Creates directory if needed.
 * B35 (#596): Append-only NDJSON — no read-modify-write race.
 */
export async function saveHistoryEntry(
  entry: WatchHistoryEntry,
  options: { historyDir: string; historyLimit: number },
): Promise<void> {
  const dir = resolveHistoryDir(options.historyDir, entry.tenantId, entry.environment);
  await safeMkdir(dir, options.historyDir);
  await migrateLegacyIfNeeded(dir, options.historyDir);

  const filepath = resolveFilepath(options.historyDir, entry.tenantId, entry.environment);
  const line = JSON.stringify(entry) + '\n';

  // Append is atomic at the OS level for small writes (< PIPE_BUF, typically 4096 bytes)
  await fs.appendFile(filepath, line, 'utf-8'); // eslint-disable-line security/detect-non-literal-fs-filename

  // Trim if over limit — read all lines, keep last N, rewrite
  try {
    const raw = await safeReadFile(filepath, options.historyDir);
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length > options.historyLimit) {
      const trimmed = lines.slice(lines.length - options.historyLimit).join('\n') + '\n';
      const tmpPath = `${filepath}.tmp`;
      await safeWriteFile(tmpPath, trimmed, options.historyDir);
      await safeRename(tmpPath, filepath, options.historyDir);
    }
  } catch (err) {
    logger.warn('saveHistoryEntry: trim failed — file may grow beyond limit', {
      filepath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Load history entries for a tenant/environment. Returns [] if file missing or invalid.
 */
export async function loadHistory(options: {
  historyDir: string;
  tenantId: string;
  environment: string;
}): Promise<WatchHistoryEntry[]> {
  const dir = resolveHistoryDir(options.historyDir, options.tenantId, options.environment);
  await migrateLegacyIfNeeded(dir, options.historyDir).catch(() => {});

  const filepath = resolveFilepath(options.historyDir, options.tenantId, options.environment);
  try {
    const raw = await safeReadFile(filepath, options.historyDir);
    const lines = raw.trim().split('\n').filter(Boolean);
    // B94 (#663): Validate each entry against Zod schema. Invalid entries are filtered.
    const entries: WatchHistoryEntry[] = [];
    let filtered = 0;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const validated = WatchHistoryEntrySchema.safeParse(parsed);
        if (validated.success) {
          entries.push(validated.data as WatchHistoryEntry);
        } else {
          filtered++;
        }
      } catch {
        filtered++;
      }
    }
    if (filtered > 0) {
      logger.warn(`loadHistory: ${filtered} of ${lines.length} entries filtered (invalid format)`, {
        filepath,
      });
    }
    return entries;
  } catch (err) {
    logger.warn('loadHistory: failed to read history file', {
      filepath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
