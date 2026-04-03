/**
 * Coverage Gap Analysis Strategy
 *
 * Takes a CondensedReport with scaffold and validation results, produces
 * AI-powered coverage gap analysis and prioritized testing roadmap.
 */

import { z } from 'zod';
import type { ReasoningOutcome } from '../types';
import type { ReasoningEngine, ReasoningRequest } from '../engine';
import type { StrategyReportInput } from './_shared';
import { buildBasePrompt, composeSystemPrompt } from '../prompts/base.prompt';
import {
  buildCoverageGapPromptInstructions,
  buildCoverageGapUserPrompt,
} from '../prompts/coverage-gap.prompt';

/** Zod schema for the LLM output — used for structured output validation */
const CoverageGapAnalysisSchema = z.object({
  coverageScore: z.number().min(0).max(100),
  summary: z.string(),
  gaps: z.array(
    z.object({
      module: z.string(),
      operation: z.string(),
      gapType: z.enum(['UNTESTED', 'PARTIAL', 'STALE', 'ERROR_ONLY']),
      riskLevel: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      reason: z.string(),
    }),
  ),
  roadmap: z.array(
    z.object({
      priority: z.number(),
      action: z.string(),
      targetOperations: z.array(z.string()),
      estimatedImpact: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      rationale: z.string(),
    }),
  ),
});

export type CoverageGapAnalysis = z.infer<typeof CoverageGapAnalysisSchema>;

export { CoverageGapAnalysisSchema };

export interface CoverageGap {
  module: string;
  operation: string;
  gapType: 'UNTESTED' | 'PARTIAL' | 'STALE' | 'ERROR_ONLY';
  riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
}

export interface RoadmapItem {
  priority: number;
  action: string;
  targetOperations: string[];
  estimatedImpact: 'HIGH' | 'MEDIUM' | 'LOW';
  rationale: string;
}

export interface CoverageGapStrategyOptions {
  report: StrategyReportInput;
  engine: ReasoningEngine;
  runId: string;
  maxTokens?: number;
}

const STRATEGY_NAME = 'coverage-gap';
const DEFAULT_MAX_TOKENS = 2048;

export async function runCoverageGapStrategy(
  options: CoverageGapStrategyOptions,
): Promise<ReasoningOutcome<CoverageGapAnalysis>> {
  const { report, engine, runId, maxTokens = DEFAULT_MAX_TOKENS } = options;

  if (report.envelopes.length === 0) {
    return {
      status: 'COMPLETED',
      result: {
        coverageScore: 0,
        summary: 'No test results in the report — unable to assess coverage.',
        gaps: [],
        roadmap: [],
      },
    };
  }

  const base = buildBasePrompt();
  const strategyInstructions = buildCoverageGapPromptInstructions();
  const systemPrompt = composeSystemPrompt(base, strategyInstructions);
  const userPrompt = buildCoverageGapUserPrompt(report);

  const request: ReasoningRequest<CoverageGapAnalysis> = {
    runId,
    tenantId: report.tenantId,
    environment: report.environment,
    strategyName: STRATEGY_NAME,
    systemPrompt,
    userPrompt,
    responseSchema: CoverageGapAnalysisSchema,
    maxTokens,
  };

  return engine.reason(request);
}
