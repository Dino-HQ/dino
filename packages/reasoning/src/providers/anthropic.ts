/**
 * @dino/reasoning — Anthropic (Claude) provider
 *
 * Wraps @anthropic-ai/sdk for completion calls. Zod validation is done in the engine.
 */

import Anthropic from '@anthropic-ai/sdk';
import { recordGet } from '@dino/core';
import type {
  ReasoningProvider,
  CompletionRequest,
  CompletionResponse,
  ProviderCapabilities,
} from '../types';
import type { CircuitBreaker } from '../circuit-breaker';

const MODEL_COSTS: Record<string, { costPer1kInput: number; costPer1kOutput: number }> = {
  'claude-sonnet-4-5-20250514': { costPer1kInput: 0.003, costPer1kOutput: 0.015 },
  'claude-sonnet-4-20250514': { costPer1kInput: 0.003, costPer1kOutput: 0.015 },
  'claude-haiku-4-5-20251001': { costPer1kInput: 0.001, costPer1kOutput: 0.005 },
  'claude-opus-4-20250115': { costPer1kInput: 0.015, costPer1kOutput: 0.075 },
};

const DEFAULT_COSTS = { costPer1kInput: 0.003, costPer1kOutput: 0.015 };

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Default 'claude-sonnet-4-5-20250514' */
  modelId?: string;
  /** Request timeout in milliseconds. Default: 30_000 (30 seconds). */
  timeoutMs?: number;
  /** Optional circuit breaker to prevent cascading failures on provider outage (#355). */
  circuitBreaker?: CircuitBreaker;
  /** Override input cost per 1K tokens. Must be paired with costPer1kOutput. */
  costPer1kInput?: number;
  /** Override output cost per 1K tokens. Must be paired with costPer1kInput. */
  costPer1kOutput?: number;
}

/**
 * Returns true if the model ID has known pricing in the built-in table.
 * Exported for pipeline integration — allows runner to warn on unknown models.
 */
export function isKnownModel(modelId: string): boolean {
  return Object.hasOwn(MODEL_COSTS, modelId);
}

/**
 * Creates a ReasoningProvider that uses the Anthropic Messages API.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): ReasoningProvider {
  const modelId = options.modelId ?? 'claude-sonnet-4-5-20250514';
  const timeout = options.timeoutMs ?? 30_000;
  const client = new Anthropic({ apiKey: options.apiKey });

  // Paired-field validation — both or neither (defense-in-depth for public API)
  const hasInput = options.costPer1kInput !== undefined;
  const hasOutput = options.costPer1kOutput !== undefined;
  if (hasInput !== hasOutput) {
    throw new Error(
      'costPer1kInput and costPer1kOutput must both be provided or both omitted. ' +
        'Partial cost overrides create invalid blended pricing.',
    );
  }
  if (hasInput) {
    if (!Number.isFinite(options.costPer1kInput) || options.costPer1kInput! < 0) {
      throw new Error('costPer1kInput must be a finite non-negative number');
    }
    if (!Number.isFinite(options.costPer1kOutput) || options.costPer1kOutput! < 0) {
      throw new Error('costPer1kOutput must be a finite non-negative number');
    }
  }

  // Resolution: explicit overrides → known table → default fallback
  const costs = hasInput
    ? { costPer1kInput: options.costPer1kInput!, costPer1kOutput: options.costPer1kOutput! }
    : (recordGet(MODEL_COSTS, modelId) ?? DEFAULT_COSTS);
  const capabilities: ProviderCapabilities = {
    structuredOutput: true,
    maxContextTokens: 200_000,
    costPer1kInput: costs.costPer1kInput,
    costPer1kOutput: costs.costPer1kOutput,
  };

  return {
    id: 'anthropic',
    modelId,
    capabilities,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const doCall = async (): Promise<CompletionResponse> => {
        const start = Date.now(); // determinism:allowed

        const response = await client.messages.create(
          {
            model: modelId,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            system: request.systemPrompt,
            messages: [{ role: 'user', content: request.userPrompt }],
          },
          { signal: AbortSignal.timeout(timeout) },
        );

        const latencyMs = Date.now() - start; // determinism:allowed

        const rawText = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        // #465: Size guard — reject oversized responses before JSON.parse
        const MAX_RESPONSE_CHARS = 256 * 1024;
        if (rawText.length > MAX_RESPONSE_CHARS) {
          throw new Error(
            `Anthropic response exceeds size limit (${rawText.length} chars, max ${MAX_RESPONSE_CHARS}). ` +
              `Model: ${modelId}. Response truncated for safety.`,
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText); // review-gate:allowed — safeParse below (REV-C3)
        } catch {
          throw new Error(
            `Anthropic response is not valid JSON (model: ${modelId}, length: ${rawText.length})`,
          );
        }

        // #421: Shape validation — defense in depth (engine also validates)
        const result = request.responseSchema.safeParse(parsed);
        if (!result.success) {
          throw new Error(
            `Anthropic response JSON does not match expected schema (model: ${modelId}): ` +
              `${result.error.issues[0]?.message ?? 'unknown'}`,
          );
        }
        parsed = result.data;

        return {
          content: parsed,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
          latencyMs,
          modelId,
        };
      };

      return options.circuitBreaker ? options.circuitBreaker.execute(doCall) : doCall();
    },
  };
}
