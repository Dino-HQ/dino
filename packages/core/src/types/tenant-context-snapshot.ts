/**
 * TenantContextSnapshot — frozen, immutable tenant context for reasoning.
 * Decision #5: Snapshot frozen per run — immutable after creation.
 * Size caps: last 10 schema changes, last 100 historical findings / 30 days.
 */

const MAX_RECENT_CHANGES = 10;
const MAX_HISTORICAL_FINDINGS = 100;
const HISTORICAL_FINDINGS_DAYS = 30;

const SNAPSHOT_VERSION = 1;

export interface SchemaChange {
  date: string;
  operations: {
    added: string[];
    removed: string[];
    modified: string[];
  };
}

export interface HistoricalFinding {
  agentId: string;
  pattern: string;
  frequency: number;
  lastSeen: string;
}

export interface TenantRule {
  id: string;
  description: string;
  scope: string;
  priority: 'must' | 'should' | 'may';
}

export interface TenantContextSnapshot {
  tenantId: string;
  snapshotVersion: number;
  capturedAt: string;
  frozen: true;
  knownModules: readonly string[];
  criticalFlows: readonly string[];
  recentChanges: readonly SchemaChange[];
  historicalFindings: readonly HistoricalFinding[];
  customRules: readonly TenantRule[];
  llmPreferences: {
    readonly preferredProvider: string;
    readonly fallbackProvider?: string | undefined;
    readonly maxCostPerRun?: number | undefined;
    readonly allowedModels?: readonly string[] | undefined;
  };
}

export interface BuildSnapshotOptions {
  tenantId: string;
  knownModules: string[];
  criticalFlows: string[];
  recentChanges: SchemaChange[];
  historicalFindings: HistoricalFinding[];
  customRules: TenantRule[];
  llmPreferences: {
    preferredProvider: string;
    fallbackProvider?: string;
    maxCostPerRun?: number;
    allowedModels?: string[];
  };
  /** Injectable clock for deterministic testing. Default: wall-clock */
  clock?: { now(): number };
}

const MAX_FREEZE_DEPTH = 10;

export function deepFreeze<T extends object>(obj: T, depth = 0): Readonly<T> {
  // Bug #481: Freeze BEFORE depth check to ensure MAX_FREEZE_DEPTH is frozen
  Object.freeze(obj);

  if (depth < MAX_FREEZE_DEPTH) {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        deepFreeze(value, depth + 1);
      }
    }
  }
  return obj;
}

function cloneSchemaChange(c: SchemaChange): SchemaChange {
  return {
    date: c.date,
    operations: {
      added: [...c.operations.added],
      removed: [...c.operations.removed],
      modified: [...c.operations.modified],
    },
  };
}

function cloneHistoricalFinding(f: HistoricalFinding): HistoricalFinding {
  return { ...f };
}

function cloneTenantRule(r: TenantRule): TenantRule {
  return { ...r };
}

export function buildSnapshot(options: BuildSnapshotOptions): TenantContextSnapshot {
  const clock = options.clock ?? { now: () => Date.now() }; // determinism:seam
  const now = new Date(clock.now());
  const cutoffDate = new Date(now.getTime() - HISTORICAL_FINDINGS_DAYS * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoffDate.toISOString();

  const cappedChanges = [...options.recentChanges]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_RECENT_CHANGES)
    .map(cloneSchemaChange);

  const cappedFindings = [...options.historicalFindings]
    .filter((f) => f.lastSeen >= cutoffIso)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, MAX_HISTORICAL_FINDINGS)
    .map(cloneHistoricalFinding);

  const snapshot: TenantContextSnapshot = {
    tenantId: options.tenantId,
    snapshotVersion: SNAPSHOT_VERSION,
    capturedAt: now.toISOString(),
    frozen: true,
    knownModules: [...options.knownModules],
    criticalFlows: [...options.criticalFlows],
    recentChanges: cappedChanges,
    historicalFindings: cappedFindings,
    customRules: options.customRules.map(cloneTenantRule),
    llmPreferences: {
      preferredProvider: options.llmPreferences.preferredProvider,
      fallbackProvider: options.llmPreferences.fallbackProvider,
      maxCostPerRun: options.llmPreferences.maxCostPerRun,
      allowedModels: options.llmPreferences.allowedModels
        ? [...options.llmPreferences.allowedModels]
        : undefined,
    },
  };

  return deepFreeze(snapshot);
}
