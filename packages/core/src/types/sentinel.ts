export const SENTINEL_LEVELS = ['observe', 'suggest', 'write', 'enforce'] as const;
export type SentinelLevel = (typeof SENTINEL_LEVELS)[number];

export const SIGNAL_TRIGGER_CLASSES = [
  'new-operation',
  'schema-drift',
  'stale-surface',
  'persistent-finding',
  'regime-change',
  'security-adjacent',
  /** Meta-signal for calibration hygiene — excluded from scan rules (#1389). */
  'calibration-review',
  'gate-failure',
  'gate-regression',
  'gate-pass',
  'readiness-improvement',
  'finding-resolution',
] as const;
export type SignalTriggerClass = (typeof SIGNAL_TRIGGER_CLASSES)[number];

export const SIGNAL_STATUSES = ['unreviewed', 'reviewed', 'dismissed', 'snoozed'] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const SIGNAL_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

export const SIGNAL_FEEDBACKS = [
  'useful',
  'expected',
  'false_positive',
  'not_actionable',
  'duplicate',
] as const;
export type SignalFeedback = (typeof SIGNAL_FEEDBACKS)[number];

export const FRONTEND_IMPACTS = ['none', 'low', 'medium', 'high', 'unknown'] as const;
export type FrontendImpact = (typeof FRONTEND_IMPACTS)[number];

export const SIGNAL_SOURCES = ['scan', 'github', 'manual', 'quality-gate'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SIGNAL_CORRELATION_STATUSES = [
  'pending',
  'scan_requested',
  'validated',
  'rejected',
  'expired',
] as const;
export type SignalCorrelationStatus = (typeof SIGNAL_CORRELATION_STATUSES)[number];

/** Scan command produced by the Sentinel decision engine (#1387). Runner handling is #1388. */
export interface SentinelScanCommand {
  tenantId: string;
  apiId: string;
  scope: {
    operations?: string[];
    agents: string[];
    depth: 'light' | 'standard' | 'deep';
    timeoutMs: number;
    reasoning: boolean;
  };
  context: {
    trigger: 'sentinel';
    triggerClasses: SignalTriggerClass[];
    signalIds: string[];
    baselineScanId?: string;
    /** PR HEAD at scan issue time — used to skip stale check-run posts (#1282, INV-5). */
    prHeadSha?: string;
  };
}
