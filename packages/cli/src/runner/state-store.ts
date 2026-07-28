/**
 * Persist runner registration state (Issue #1150).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asRunnerId, asTenantId, type RunnerId, type TenantId } from '@dino/core';

export interface RunnerState {
  runnerId: RunnerId;
  tenantId: TenantId;
  token: string;
  cloudEndpoint: string;
  registeredAt: string;
}

export interface StateStorage {
  read(): Promise<RunnerState | null>;
  write(state: RunnerState): Promise<void>;
}

export function getDefaultRunnerStatePath(): string {
  return path.join(os.homedir(), '.dino', 'runner-state.json');
}

export function createFileStateStorage(filePath: string): StateStorage {
  /* eslint-disable security/detect-non-literal-fs-filename -- path is the configured runner state file (~/.dino/runner-state.json or injectable temp path in tests), not directory traversal from scan targets */
  const storage: StateStorage = {
    async read(): Promise<RunnerState | null> {
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (
          typeof parsed.runnerId !== 'string' ||
          typeof parsed.tenantId !== 'string' ||
          typeof parsed.token !== 'string' ||
          typeof parsed.cloudEndpoint !== 'string' ||
          typeof parsed.registeredAt !== 'string'
        ) {
          throw new TypeError('Corrupted runner state: missing or invalid fields');
        }
        return {
          runnerId: asRunnerId(parsed.runnerId),
          tenantId: asTenantId(parsed.tenantId),
          token: parsed.token,
          cloudEndpoint: parsed.cloudEndpoint,
          registeredAt: parsed.registeredAt,
        };
      } catch (err) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? (err as NodeJS.ErrnoException).code
            : '';
        if (code === 'ENOENT') return null;
        throw err;
      }
    },

    async write(state: RunnerState): Promise<void> {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`; // determinism:allowed
      try {
        await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await fs.rename(tmp, filePath);
      } finally {
        await fs.rm(tmp, { force: true });
      }
    },
  };
  /* eslint-enable security/detect-non-literal-fs-filename */
  return storage;
}
