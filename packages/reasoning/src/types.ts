/**
 * @dino/reasoning — AI Reasoning Types
 *
 * Types-only scaffolding for the reasoning layer. No runtime code.
 * Source of truth: docs/plans/roadmap.md (M0 Intelligence Layer)
 */

import type { ZodType } from 'zod';
import type { SeverityScore } from '@dino/core';

// --- Provider abstraction (LLM-agnostic) ---

/**
 * LLM-agnostic provider interface. Implementations (e.g. AnthropicProvider in #180)
 * perform completion with structured output validated by Zod.
 */
export interface ReasoningProvider {
  /** Unique provider identifier (e.g. 'anthropic', 'openai') */
  readonly id: string;
  /** Model identifier used for this provider (e.g. 'claude-sonnet-4-20250514') */
  readonly modelId: string;
  /** Perform a completion; returns Zod-parsed structured output in content. */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Capabilities used by router for budget and model selection */
  readonly capabilities: ProviderCapabilities;
}

/**
 * Request payload for a single LLM completion. All AI output is Zod-validated (Decision #7).
 */
export interface CompletionRequest {
  /** System prompt (instructions, role) */
  systemPrompt: string;
  /** User prompt (actual query or task input) */
  userPrompt: string;
  /** Zod schema for parsing and validating the LLM response */
  responseSchema: ZodType;
  /** Maximum tokens for the completion response */
  maxTokens: number;
  /** Sampling temperature (0–1) */
  temperature: number;
}

/**
 * Response from a completion call. content is the Zod-parsed structured output, not raw string.
 */
export interface CompletionResponse {
  /** Parsed structured output from the provider (shape defined by request.responseSchema) */
  content: unknown;
  /** Token usage for billing and budget tracking */
  usage: { inputTokens: number; outputTokens: number };
  /** Wall-clock latency in milliseconds */
  latencyMs: number;
  /** Model that produced the response */
  modelId: string;
}

/**
 * Provider capabilities used by the router for budget math and model selection.
 */
export interface ProviderCapabilities {
  /** Whether the provider supports structured output (e.g. tool use / JSON mode) */
  structuredOutput: boolean;
  /** Maximum context window size in tokens */
  maxContextTokens: number;
  /** Cost per 1k input tokens in USD */
  costPer1kInput: number;
  /** Cost per 1k output tokens in USD */
  costPer1kOutput: number;
}

// --- Router (multi-provider) ---

/**
 * Routes a reasoning request to a specific provider and degradation step. Sync per Decision #15 (no mid-call switching).
 */
export interface LLMRouter {
  /** Returns the routing decision (provider, step, cost estimate, skipReasoning). */
  route(request: RoutingRequest): RoutingDecision;
}

/**
 * Input to the router for provider selection.
 */
export interface RoutingRequest {
  /** Kind of reasoning task */
  taskType: 'analysis' | 'planning' | 'triage' | 'summary';
  /** Severity level from aggregated run (from @dino/core) */
  severityLevel: SeverityScore['level'];
  /** Tenant preferences for provider and budget */
  tenantPreferences: LLMPreferences;
  /** Estimated token count for the request */
  estimatedTokens: number;
}

/** Steps of the degradation ladder (1 = full, 4 = skip). */
export type DegradationStep = 1 | 2 | 3 | 4;

/** Status assigned when a reasoning step completes. */
export type ReasoningSuccessStatus = 'COMPLETED' | 'COMPLETED_DEGRADED';

/**
 * The result of routing — tells the caller which provider and degradation step to use.
 */
export interface RoutingDecision {
  /** The provider to use for this call */
  provider: ReasoningProvider;
  /** Which step of the degradation ladder (1–4) */
  degradationStep: DegradationStep;
  /** The status to assign if this step completes successfully */
  successStatus: ReasoningSuccessStatus;
  /** Pre-call cost estimate in USD */
  estimatedCostUsd: number;
  /** If true, skip the LLM call entirely (step 4) */
  skipReasoning: boolean;
}

/**
 * Tenant-level preferences for LLM usage (provider, fallback, budget).
 */
export interface LLMPreferences {
  /** Preferred provider id (e.g. 'anthropic') */
  preferredProvider: string;
  /** Fallback provider for degradation ladder (Decision #9) */
  fallbackProvider?: string;
  /** Maximum cost per run in USD */
  maxCostPerRun?: number;
  /** Allowed model ids (empty or undefined = no restriction) */
  allowedModels?: string[];
}

// --- Reasoning output ---

/**
 * Status of a reasoning run. Maps to the 4-step degradation ladder (Decision #9).
 */
export type ReasoningStatus =
  | 'COMPLETED'
  | 'COMPLETED_DEGRADED'
  | 'SKIPPED_BUDGET'
  | 'SKIPPED_DISABLED'
  | 'TIMEOUT'
  | 'FAILED';

/**
 * Trace metadata for a completed reasoning call (optional when status is skipped).
 */
export interface ReasoningTrace {
  /** Run identifier */
  runId: string;
  /** Strategy that produced the result (e.g. 'triage', 'summary') */
  strategyUsed: string;
  /** Provider id used */
  provider: string;
  /** Model id used */
  model: string;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens consumed */
  outputTokens: number;
  /** Estimated cost in USD for budget tracking (Decision #6) */
  costEstimateUsd: number;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Step in the 4-step degradation ladder (Decision #9) */
  degradationStep: 1 | 2 | 3 | 4;
  /** Whether the result was served from cache */
  cached: boolean;
}

/**
 * Outcome of a reasoning run. Generic T is the Zod-validated strategy output.
 * Skipped runs have no trace; failed runs may have error and/or budget.
 */
export interface ReasoningOutcome<T> {
  /** Final status of the run */
  status: ReasoningStatus;
  /** Zod-validated output from the strategy (present when status is COMPLETED or COMPLETED_DEGRADED) */
  result?: T;
  /** Trace for completed calls; omitted when skipped */
  trace?: ReasoningTrace;
  /** Error details when status is FAILED, TIMEOUT, or budget/schema issues */
  error?: {
    code: 'BudgetExceeded' | 'ProviderError' | 'SchemaInvalid' | 'Timeout';
    message: string;
  };
  /** Budget and degradation info when relevant */
  budget?: {
    maxCostPerRunUsd: number;
    estimatedFullUsd: number;
    actualUsd?: number;
    degradationStep: 1 | 2 | 3 | 4;
  };
}
