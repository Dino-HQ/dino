/**
 * @dino/analytics — Event Taxonomy
 *
 * Discriminated union of all analytics events Dino can emit.
 * Categories: pipeline.*, cli.*, portal.* (stubs for dashboard.*, auth.*, pr.*, mcp.*, slack.* added later)
 *
 * Convention: event type = "<category>.<noun>.<verb_past>" in dot notation.
 * Examples: pipeline.run.started, cli.command.invoked, portal.page.viewed
 * Every event carries a timestamp and optional tenantId.
 *
 * Batch 10+11: sanitization helpers to avoid leaking credentials in event payloads.
 */

import { recordSet, sanitizeErrorMessage } from '@dino/core';

/** Allowlist of CLI flag keys safe to include in analytics (Batch 10+11, #474) */
export const SAFE_CLI_FLAGS = [
  'tenant',
  'env',
  'format',
  'quiet',
  'output',
  'dryRun',
  'limit',
  'verbose',
] as const;

/**
 * Sanitize an error string for use in analytics (pipeline.tool.failed, cli.command.failed).
 * Delegates to @dino/core sanitizeErrorMessage.
 */
export function sanitizeEventError(message: string): string {
  return sanitizeErrorMessage(message);
}

/**
 * Return a copy of flags retaining only allowlisted keys (SAFE_CLI_FLAGS).
 * Prevents leaking secrets or PII in cli.command.invoked.
 */
export function sanitizeCliFlags(flags: Record<string, unknown>): Record<string, unknown> {
  const allowlist = new Set<string>(SAFE_CLI_FLAGS);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (allowlist.has(k)) recordSet(out, k, v);
  }
  return out;
}

/**
 * Sanitize a search query for portal/search events (e.g. strip credentials).
 * For now delegates to sanitizeErrorMessage for consistency.
 */
export function sanitizeSearchQuery(query: string): string {
  return sanitizeErrorMessage(query);
}

// ── Base fields present on every event ──

export interface EventBase {
  /** ISO 8601 timestamp — auto-populated by createTracker() when omitted */
  timestamp?: string;
  /** Tenant that triggered the event (optional for pre-auth events) */
  tenantId?: string;
}

// ── Pipeline events ──

export type PipelineTrigger = 'pr' | 'nightly' | 'weekly' | 'monthly' | 'manual' | 'watch';

export interface PipelineRunStarted extends EventBase {
  type: 'pipeline.run.started';
  properties: {
    runId: string;
    environment: string;
    trigger: PipelineTrigger;
    toolCount: number;
    tools: string[];
  };
}

export interface PipelineRunCompleted extends EventBase {
  type: 'pipeline.run.completed';
  properties: {
    runId: string;
    environment: string;
    trigger: PipelineTrigger;
    durationMs: number;
    toolsRun: string[];
    toolsCompleted: string[];
    toolsFailed: string[];
    strategiesRun: string[];
    reasoningEnabled: boolean;
    degraded: boolean;
    emptyRun: boolean;
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    overallSeverity: string;
  };
}

export interface PipelineRunFailed extends EventBase {
  type: 'pipeline.run.failed';
  properties: {
    runId: string;
    environment: string;
    trigger: PipelineTrigger;
    durationMs: number;
    error: string;
  };
}

export interface PipelineToolCompleted extends EventBase {
  type: 'pipeline.tool.completed';
  properties: {
    runId: string;
    toolName: string;
    durationMs: number;
    severity: string;
    total: number;
    passed: number;
    failed: number;
  };
}

export interface PipelineToolFailed extends EventBase {
  type: 'pipeline.tool.failed';
  properties: {
    runId: string;
    toolName: string;
    error: string;
  };
}

export interface PipelineReasoningCompleted extends EventBase {
  type: 'pipeline.reasoning.completed';
  properties: {
    runId: string;
    strategyName: string;
    durationMs: number;
    status: string;
  };
}

// ── CLI events (stubs — wired in #307) ──

export interface CliCommandInvoked extends EventBase {
  type: 'cli.command.invoked';
  properties: {
    command: string;
    flags: Record<string, unknown>;
    version: string;
  };
}

export interface CliCommandCompleted extends EventBase {
  type: 'cli.command.completed';
  properties: {
    command: string;
    durationMs: number;
    exitCode: number;
  };
}

export interface CliCommandFailed extends EventBase {
  type: 'cli.command.failed';
  properties: {
    command: string;
    durationMs: number;
    error: string;
  };
}

// ── Portal events (stubs — wired in #308) ──

export interface PortalPageViewed extends EventBase {
  type: 'portal.page.viewed';
  properties: {
    path: string;
    tenantId: string;
  };
}

export interface PortalReportExported extends EventBase {
  type: 'portal.report.exported';
  properties: {
    reportId: string;
    tenantId: string;
    format: string;
  };
}

export interface PortalSearchPerformed extends EventBase {
  type: 'portal.search.performed';
  properties: {
    query: string;
    tenantId: string;
    resultCount: number;
  };
}

// ── Discriminated union ──

export type DinoEvent =
  // Pipeline
  | PipelineRunStarted
  | PipelineRunCompleted
  | PipelineRunFailed
  | PipelineToolCompleted
  | PipelineToolFailed
  | PipelineReasoningCompleted
  // CLI
  | CliCommandInvoked
  | CliCommandCompleted
  | CliCommandFailed
  // Portal
  | PortalPageViewed
  | PortalReportExported
  | PortalSearchPerformed;

/**
 * Extract the event type string union for type-safe switch/case.
 */
export type DinoEventType = DinoEvent['type'];
