// @dino/analytics — Barrel exports

// --- Events ---
export {
  sanitizeEventError,
  sanitizeCliFlags,
  sanitizeSearchQuery,
  SAFE_CLI_FLAGS,
} from './events';
export type {
  DinoEvent,
  DinoEventType,
  EventBase,
  PipelineRunStarted,
  PipelineRunCompleted,
  PipelineRunFailed,
  PipelineToolCompleted,
  PipelineToolFailed,
  PipelineReasoningCompleted,
  CliCommandInvoked,
  CliCommandCompleted,
  CliCommandFailed,
  PortalPageViewed,
  PortalReportExported,
  PortalSearchPerformed,
} from './events';

// --- Tracker ---
export { createTracker } from './tracker';
export type { Tracker, TrackerOptions } from './tracker';

// --- Adapters ---
export type { AnalyticsAdapter } from './adapters/types';
export { createConsoleAdapter } from './adapters/console.adapter';
export { createNoopAdapter } from './adapters/noop.adapter';
export { createPostHogAdapter } from './adapters/posthog.adapter';
export type { PostHogAdapterOptions } from './adapters/posthog.adapter';
