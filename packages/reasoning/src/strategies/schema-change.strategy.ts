/**
 * Schema Change Analysis Strategy — R0 Milestone
 *
 * Takes a CondensedReport with response-validator results and produces
 * AI-powered schema change analysis. Decision #10: only strategy in R0.
 */

import { z } from 'zod';
import type { ReasoningOutcome } from '../types';
import type { ReasoningEngine, ReasoningRequest } from '../engine';
import type { StrategyReportInput } from './_shared';
import { buildBasePrompt, composeSystemPrompt } from '../prompts/base.prompt';
import {
  buildApiContractPromptInstructions,
  buildSchemaChangeUserPrompt,
} from '../prompts/api-contract.prompt';

/** Zod schema for the LLM output — used for structured output validation */
const SchemaChangeAnalysisSchema = z.object({
  overallRisk: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE']),
  summary: z.string(),
  changes: z.array(
    z.object({
      operation: z.string(),
      changeType: z.enum(['BREAKING', 'ADDITIVE', 'INCONSISTENCY']),
      description: z.string(),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    }),
  ),
  recommendations: z.array(
    z.object({
      priority: z.number(),
      action: z.string(),
      rationale: z.string(),
    }),
  ),
});

export type SchemaChangeAnalysis = z.infer<typeof SchemaChangeAnalysisSchema>;

export { SchemaChangeAnalysisSchema };

export interface SchemaChange {
  operation: string;
  changeType: 'BREAKING' | 'ADDITIVE' | 'INCONSISTENCY';
  description: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface Recommendation {
  priority: number;
  action: string;
  rationale: string;
}

export interface SchemaChangeStrategyOptions {
  /** Condensed report containing response-validator envelopes */
  report: StrategyReportInput;
  /** The reasoning engine to use */
  engine: ReasoningEngine;
  /** Run ID for trace correlation */
  runId: string;
  /** Max output tokens (default: 2048) */
  maxTokens?: number;
}

const STRATEGY_NAME = 'schema-change';
const DEFAULT_MAX_TOKENS = 2048;

export async function runSchemaChangeStrategy(
  options: SchemaChangeStrategyOptions,
): Promise<ReasoningOutcome<SchemaChangeAnalysis>> {
  const { report, engine, runId, maxTokens = DEFAULT_MAX_TOKENS } = options;

  const validatorEnvelopes = report.envelopes.filter((e) => e.toolName === 'response-validator');

  if (validatorEnvelopes.length === 0) {
    return {
      status: 'COMPLETED',
      result: {
        overallRisk: 'NONE',
        summary: 'No response-validator results in the report.',
        changes: [],
        recommendations: [],
      },
    };
  }

  const base = buildBasePrompt();
  const strategyInstructions = buildApiContractPromptInstructions();
  const systemPrompt = composeSystemPrompt(base, strategyInstructions);
  const userPrompt = buildSchemaChangeUserPrompt(report);

  const request: ReasoningRequest<SchemaChangeAnalysis> = {
    runId,
    tenantId: report.tenantId,
    environment: report.environment,
    strategyName: STRATEGY_NAME,
    systemPrompt,
    userPrompt,
    responseSchema: SchemaChangeAnalysisSchema,
    maxTokens,
  };

  return engine.reason(request);
}
