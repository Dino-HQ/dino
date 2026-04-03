/**
 * @dino/reasoning — LLM Router
 *
 * Implements the 4-step degradation ladder (Decision #9). Selects provider and step
 * based on cost estimation and tenant preferences.
 */

import type { LLMRouter, RoutingRequest, RoutingDecision, ReasoningProvider } from './types';
import type { ProviderRegistry } from './providers/index';

export interface LLMRouterOptions {
  registry: ProviderRegistry;
  /** Default budget if tenant has no maxCostPerRun (default: 1.00 USD) */
  defaultBudgetUsd?: number;
}

const DEFAULT_BUDGET_USD = 1;

/**
 * Reduced-scope multiplier for degradation steps 2 & 3.
 * Smaller prompt → ~40% of full token cost estimate.
 */
const REDUCED_SCOPE_FACTOR = 0.4;

/** Default output tokens when no estimate is provided. */
const DEFAULT_OUTPUT_TOKENS = 2048;

export function createRouter(options: LLMRouterOptions): LLMRouter {
  const { registry, defaultBudgetUsd = DEFAULT_BUDGET_USD } = options;

  return {
    route(request: RoutingRequest): RoutingDecision {
      const budget = request.tenantPreferences.maxCostPerRun ?? defaultBudgetUsd;
      const outputTokens = DEFAULT_OUTPUT_TOKENS;

      const preferred = resolveProvider(registry, request.tenantPreferences.preferredProvider);
      const fallback = request.tenantPreferences.fallbackProvider
        ? resolveProvider(registry, request.tenantPreferences.fallbackProvider)
        : undefined;

      // Step 1: Full scope, preferred provider
      const step1Cost = estimateCost(preferred, request.estimatedTokens, outputTokens);
      if (step1Cost <= budget) {
        return {
          provider: preferred,
          degradationStep: 1,
          successStatus: 'COMPLETED',
          estimatedCostUsd: step1Cost,
          skipReasoning: false,
        };
      }

      // Step 2: Reduced scope, preferred provider
      const reducedInputTokens = Math.ceil(request.estimatedTokens * REDUCED_SCOPE_FACTOR);
      const step2Cost = estimateCost(preferred, reducedInputTokens, outputTokens);
      if (step2Cost <= budget) {
        return {
          provider: preferred,
          degradationStep: 2,
          successStatus: 'COMPLETED_DEGRADED',
          estimatedCostUsd: step2Cost,
          skipReasoning: false,
        };
      }

      // Step 3: Reduced scope, fallback provider (if available)
      if (fallback) {
        const step3Cost = estimateCost(fallback, reducedInputTokens, outputTokens);
        if (step3Cost <= budget) {
          return {
            provider: fallback,
            degradationStep: 3,
            successStatus: 'COMPLETED_DEGRADED',
            estimatedCostUsd: step3Cost,
            skipReasoning: false,
          };
        }
      }

      // Step 4: Skip reasoning entirely
      const reportingProvider = fallback ?? preferred;
      return {
        provider: reportingProvider,
        degradationStep: 4,
        successStatus: 'COMPLETED_DEGRADED',
        estimatedCostUsd: 0,
        skipReasoning: true,
      };
    },
  };
}

function resolveProvider(registry: ProviderRegistry, id: string): ReasoningProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw new Error(`Provider "${id}" is not registered`);
  }
  return provider;
}

function estimateCost(
  provider: ReasoningProvider,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1000) * provider.capabilities.costPer1kInput +
    (outputTokens / 1000) * provider.capabilities.costPer1kOutput
  );
}
