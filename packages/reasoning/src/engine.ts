/**
 * @dino/reasoning — Reasoning engine
 *
 * Orchestrates provider calls with Zod validation, budget checks, and optional cache.
 */

import type { ZodType } from 'zod';
import { createHash } from 'node:crypto';
import type { ReasoningCache } from './cache';
import { sanitizeLLMInput } from './sanitize';
import type {
  ReasoningProvider,
  CompletionRequest,
  ReasoningOutcome,
  ReasoningTrace,
} from './types';

export interface ReasoningEngineOptions {
  provider: ReasoningProvider;
  /** When false, all calls return SKIPPED_DISABLED (default true) */
  enabled?: boolean;
  /** Budget cap per run in USD (default 1.00) */
  maxCostPerRunUsd?: number;
  /** Optional cache instance */
  cache?: ReasoningCache;
}

export interface ReasoningEngine {
  reason<T>(request: ReasoningRequest<T>): Promise<ReasoningOutcome<T>>;
}

export interface ReasoningRequest<T> {
  runId: string;
  /** Tenant identifier — used for cache isolation (SOC 2 CC6.1) */
  tenantId: string;
  /** Environment name for cache isolation (e.g. 'qa', 'production') */
  environment?: string;
  strategyName: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: ZodType<T>;
  maxTokens: number;
  /** Default 0.2 */
  temperature?: number;
}

/**
 * Creates a reasoning engine that calls the given provider with budget and cache support.
 */
export function createReasoningEngine(options: ReasoningEngineOptions): ReasoningEngine {
  const { provider, enabled = true, maxCostPerRunUsd = 1, cache } = options;
  let cumulativeCostUsd = 0;

  return {
    async reason<T>(request: ReasoningRequest<T>): Promise<ReasoningOutcome<T>> {
      if (!enabled) {
        return { status: 'SKIPPED_DISABLED' };
      }

      const temperature = request.temperature ?? 0.2;
      const cacheKey = computeCacheKey({
        tenantId: request.tenantId,
        environment: request.environment ?? 'default',
        strategyName: request.strategyName,
        providerId: provider.id,
        modelId: provider.modelId,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        maxTokens: request.maxTokens,
        temperature,
        schemaFp: schemaFingerprint(request.responseSchema),
      });

      if (cache) {
        const cached = cache.get<T>(cacheKey);
        if (cached) {
          if (cached.trace) {
            return { ...cached, trace: { ...cached.trace, cached: true } };
          }
          return cached;
        }
      }

      const estimatedInputTokens = Math.ceil(
        (request.systemPrompt.length + request.userPrompt.length) / 4,
      );
      const estimatedOutputTokens = request.maxTokens;
      const estimatedCostUsd =
        (estimatedInputTokens / 1000) * provider.capabilities.costPer1kInput +
        (estimatedOutputTokens / 1000) * provider.capabilities.costPer1kOutput;

      if (cumulativeCostUsd + estimatedCostUsd > maxCostPerRunUsd) {
        const total = cumulativeCostUsd + estimatedCostUsd;
        return {
          status: 'SKIPPED_BUDGET',
          error: {
            code: 'BudgetExceeded',
            message: `Cumulative cost $${total.toFixed(4)} exceeds budget $${maxCostPerRunUsd.toFixed(2)}`,
          },
          budget: {
            maxCostPerRunUsd,
            estimatedFullUsd: total,
            degradationStep: 4,
          },
        };
      }

      const completionRequest: CompletionRequest = {
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        responseSchema: request.responseSchema,
        maxTokens: request.maxTokens,
        temperature,
      };

      let response;
      try {
        response = await provider.complete(completionRequest);
      } catch (err) {
        return {
          status: 'FAILED',
          error: {
            code: 'ProviderError',
            message: sanitizeLLMInput(err instanceof Error ? err.message : String(err)),
          },
        };
      }

      const parseResult = request.responseSchema.safeParse(response.content);
      if (!parseResult.success) {
        return {
          status: 'FAILED',
          error: {
            code: 'SchemaInvalid',
            message: `Response failed schema validation: ${parseResult.error.message}`,
          },
        };
      }

      const actualCostUsd =
        (response.usage.inputTokens / 1000) * provider.capabilities.costPer1kInput +
        (response.usage.outputTokens / 1000) * provider.capabilities.costPer1kOutput;

      cumulativeCostUsd += estimatedCostUsd;

      const trace: ReasoningTrace = {
        runId: request.runId,
        strategyUsed: request.strategyName,
        provider: provider.id,
        model: response.modelId,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costEstimateUsd: actualCostUsd,
        latencyMs: response.latencyMs,
        degradationStep: 1,
        cached: false,
      };

      const outcome: ReasoningOutcome<T> = {
        status: 'COMPLETED',
        result: parseResult.data,
        trace,
        budget: {
          maxCostPerRunUsd,
          estimatedFullUsd: estimatedCostUsd,
          actualUsd: actualCostUsd,
          degradationStep: 1,
        },
      };

      if (cache) {
        cache.set(cacheKey, outcome);
      }

      return outcome;
    },
  };
}

/**
 * Produces a stable string from a Zod schema for cache-key differentiation.
 * Uses sorted shape keys for z.object(); falls back to constructor name.
 * Not a full deep hash — strategyName is the primary discriminator.
 */
function schemaFingerprint(schema: ZodType): string {
  const s = schema as { shape?: Record<string, unknown> };
  if (s.shape && typeof s.shape === 'object') {
    return JSON.stringify(Object.keys(s.shape).sort((a, b) => a.localeCompare(b)));
  }
  // B44 (#610): constructor.name is mangled by esbuild minification. Use description or stringify.
  return schema.description ?? JSON.stringify(schema);
}

interface CacheKeyInput {
  tenantId: string;
  environment: string;
  strategyName: string;
  providerId: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
  schemaFp: string;
}

/** Null byte delimiter prevents field-boundary collisions in hash (e.g. "ab"+"cd" vs "abcd"+""). */
const D = '\0';

function computeCacheKey(input: CacheKeyInput): string {
  return createHash('sha256')
    .update(input.tenantId)
    .update(D)
    .update(input.environment)
    .update(D)
    .update(input.strategyName)
    .update(D)
    .update(input.providerId)
    .update(D)
    .update(input.modelId)
    .update(D)
    .update(input.systemPrompt)
    .update(D)
    .update(input.userPrompt)
    .update(D)
    .update(String(input.maxTokens))
    .update(D)
    .update(String(input.temperature))
    .update(D)
    .update(input.schemaFp)
    .digest('hex');
}
