// @dino/reasoning — Barrel exports
// Do not re-export ZodType; consumers import from 'zod' if needed.

// --- Types ---
export type {
  ReasoningProvider,
  CompletionRequest,
  CompletionResponse,
  ProviderCapabilities,
} from './types';

export type { LLMRouter, RoutingRequest, RoutingDecision, LLMPreferences } from './types';

// --- Router ---
export { createRouter } from './router';
export type { LLMRouterOptions } from './router';

// --- Provider Registry ---
export { createProviderRegistry } from './providers/index';
export type { ProviderRegistry } from './providers/index';

export type { ReasoningStatus, ReasoningTrace, ReasoningOutcome } from './types';

// --- Engine ---
export { createReasoningEngine } from './engine';
export type { ReasoningEngine, ReasoningEngineOptions, ReasoningRequest } from './engine';

// --- Config ---
export { parseReasoningConfig } from './config';
export type { ReasoningConfig } from './config';

// --- Providers ---
export { createAnthropicProvider, isKnownModel } from './providers/anthropic';
export type { AnthropicProviderOptions } from './providers/anthropic';

// --- Prompts ---
export { buildBasePrompt, composeSystemPrompt, escapeCodeFence } from './prompts/base.prompt';
export type { BasePromptSections } from './prompts/base.prompt';

// --- Cache ---
export { createReasoningCache } from './cache';
export type { ReasoningCache, CacheOptions } from './cache';

// --- Circuit Breaker (#355) ---
export { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
export type { CircuitState, CircuitBreakerOptions } from './circuit-breaker';

// --- Sanitization (HC #22) ---
export { sanitizeLLMInput } from './sanitize';
export type { TenantPattern } from './sanitize';

// --- Strategies ---
export {
  runSchemaChangeStrategy,
  SchemaChangeAnalysisSchema,
} from './strategies/schema-change.strategy';
export type {
  SchemaChangeAnalysis,
  SchemaChange,
  Recommendation,
  SchemaChangeStrategyOptions,
} from './strategies/schema-change.strategy';

export {
  runCoverageGapStrategy,
  CoverageGapAnalysisSchema,
} from './strategies/coverage-gap.strategy';
export type {
  CoverageGapAnalysis,
  CoverageGap,
  RoadmapItem,
  CoverageGapStrategyOptions,
} from './strategies/coverage-gap.strategy';

export { runCrossAgentStrategy, CrossAgentAnalysisSchema } from './strategies/cross-agent.strategy';
export type {
  CrossAgentAnalysis,
  Correlation,
  CorrelationFinding,
  BlindSpot,
  CrossAgentStrategyOptions,
} from './strategies/cross-agent.strategy';

export {
  runApiDescriptionStrategy,
  ApiDescriptionBatchSchema,
} from './strategies/api-description.strategy';
export type {
  ApiDescriptionBatch,
  ApiDescriptionEntry,
  ApiDescriptionStrategyOptions,
} from './strategies/api-description.strategy';

// --- Strategy Prompts ---
export {
  buildApiContractPromptInstructions,
  buildSchemaChangeUserPrompt,
} from './prompts/api-contract.prompt';

export {
  buildCoverageGapPromptInstructions,
  buildCoverageGapUserPrompt,
} from './prompts/coverage-gap.prompt';

export {
  buildCrossAgentPromptInstructions,
  buildCrossAgentUserPrompt,
} from './prompts/cross-agent.prompt';

export {
  buildApiDescriptionPromptInstructions,
  buildApiDescriptionUserPrompt,
} from './prompts/api-description.prompt';
