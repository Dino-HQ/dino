/**
 * API Description Strategy — AI-generated descriptions for operations without schemaDescription.
 *
 * Takes a batch of catalog entries (structural type; no import from host) and produces
 * short, consistent descriptions via the reasoning engine.
 */

import { z } from 'zod';
import type { ReasoningOutcome } from '../types';
import type { ReasoningEngine, ReasoningRequest } from '../engine';
import { buildBasePrompt, composeSystemPrompt } from '../prompts/base.prompt';
import {
  buildApiDescriptionPromptInstructions,
  buildApiDescriptionUserPrompt,
} from '../prompts/api-description.prompt';

const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
const AuthRequiredSchema = z.enum(['yes', 'no', 'unknown']);

/** Single description produced by the LLM for one operation */
const DescriptionItemSchema = z.object({
  operationName: z.string(),
  description: z.string().min(10).max(500),
  authRequired: AuthRequiredSchema,
  sideEffects: z.array(z.string()).max(5),
  relatedOperations: z.array(z.string()).max(5),
  confidence: ConfidenceSchema,
});

/** Zod schema for the LLM output — used for structured output validation */
export const ApiDescriptionBatchSchema = z.object({
  batchSummary: z.string(),
  descriptions: z.array(DescriptionItemSchema),
});

export type ApiDescriptionBatch = z.infer<typeof ApiDescriptionBatchSchema>;

/**
 * Structural type for catalog entries passed into the strategy.
 * Subset of OperationCatalogEntry; no import from src/intelligence.
 */
export interface ApiDescriptionEntry {
  name: string;
  type: 'query' | 'mutation' | 'subscription';
  module: string;
  deprecated: boolean;
  schemaDescription: string | null;
  args: Array<{ name: string; type: string; isRequired: boolean }>;
  returnType: string;
  toolFindings: {
    toolsRun: string[];
    worstSeverity: string;
    byTool: Record<string, { severity: string; findingCount: number; examples: string[] }>;
  };
}

export interface ApiDescriptionStrategyOptions {
  engine: ReasoningEngine;
  runId: string;
  /** Tenant identifier — required for cache isolation (SOC 2 CC6.1) */
  tenantId: string;
  /** Environment name for cache isolation (e.g. 'qa', 'production'). Default: 'default'. */
  environment?: string;
  entries: ApiDescriptionEntry[];
  batchSize?: number;
  maxTokens?: number;
}

const STRATEGY_NAME = 'api-description';
const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Runs the API description strategy: filters entries without schemaDescription,
 * batches them, and asks the reasoning engine for short descriptions.
 */
export async function runApiDescriptionStrategy(
  options: ApiDescriptionStrategyOptions,
): Promise<ReasoningOutcome<ApiDescriptionBatch>> {
  const {
    engine,
    runId,
    tenantId,
    entries,
    batchSize = DEFAULT_BATCH_SIZE,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = options;

  const withoutDescription = entries.filter((e) => !e.schemaDescription);

  if (withoutDescription.length === 0) {
    return {
      status: 'COMPLETED',
      result: {
        batchSummary: 'All operations already have schema descriptions.',
        descriptions: [],
      },
    };
  }

  const batch = withoutDescription.slice(0, batchSize);
  const base = buildBasePrompt();
  const strategyInstructions = buildApiDescriptionPromptInstructions();
  const systemPrompt = composeSystemPrompt(base, strategyInstructions);
  const userPrompt = buildApiDescriptionUserPrompt(batch);

  const request: ReasoningRequest<ApiDescriptionBatch> = {
    runId,
    tenantId,
    environment: options.environment,
    strategyName: STRATEGY_NAME,
    systemPrompt,
    userPrompt,
    responseSchema: ApiDescriptionBatchSchema,
    maxTokens,
  };

  return engine.reason(request);
}
