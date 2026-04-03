/**
 * Cross-Agent Reasoning Strategy
 *
 * The "brain" — correlates findings across multiple agent tools to identify
 * compound risks and blind spots that no single strategy can detect.
 */

import { z } from 'zod';
import type { ReasoningOutcome } from '../types';
import type { ReasoningEngine, ReasoningRequest } from '../engine';
import type { StrategyReportInput } from './_shared';
import { buildBasePrompt, composeSystemPrompt } from '../prompts/base.prompt';
import {
  buildCrossAgentPromptInstructions,
  buildCrossAgentUserPrompt,
} from '../prompts/cross-agent.prompt';

const CrossAgentAnalysisSchema = z.object({
  overallRisk: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE']),
  summary: z.string(),
  correlations: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      toolsInvolved: z.array(z.string()).min(2),
      findings: z.array(
        z.object({
          toolName: z.string(),
          classification: z.string(),
          detail: z.string(),
        }),
      ),
      impact: z.string(),
      recommendation: z.string(),
    }),
  ),
  blindSpots: z.array(
    z.object({
      area: z.string(),
      reason: z.string(),
      suggestedAction: z.string(),
    }),
  ),
});

export type CrossAgentAnalysis = z.infer<typeof CrossAgentAnalysisSchema>;

export { CrossAgentAnalysisSchema };

export interface Correlation {
  id: string;
  title: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  toolsInvolved: string[];
  findings: CorrelationFinding[];
  impact: string;
  recommendation: string;
}

export interface CorrelationFinding {
  toolName: string;
  classification: string;
  detail: string;
}

export interface BlindSpot {
  area: string;
  reason: string;
  suggestedAction: string;
}

export interface CrossAgentStrategyOptions {
  report: StrategyReportInput;
  engine: ReasoningEngine;
  runId: string;
  maxTokens?: number;
}

const STRATEGY_NAME = 'cross-agent';
const DEFAULT_MAX_TOKENS = 2048;

export async function runCrossAgentStrategy(
  options: CrossAgentStrategyOptions,
): Promise<ReasoningOutcome<CrossAgentAnalysis>> {
  const { report, engine, runId, maxTokens = DEFAULT_MAX_TOKENS } = options;

  const uniqueTools = new Set(report.envelopes.map((e) => e.toolName));
  if (uniqueTools.size < 2) {
    return {
      status: 'COMPLETED',
      result: {
        overallRisk: 'NONE',
        summary:
          uniqueTools.size === 0
            ? 'No tool results in the report — unable to perform cross-agent analysis.'
            : `Only one tool (${[...uniqueTools][0]}) present — cross-agent correlation requires results from at least 2 tools.`,
        correlations: [],
        blindSpots: [],
      },
    };
  }

  const base = buildBasePrompt();
  const strategyInstructions = buildCrossAgentPromptInstructions();
  const systemPrompt = composeSystemPrompt(base, strategyInstructions);
  const userPrompt = buildCrossAgentUserPrompt(report);

  const request: ReasoningRequest<CrossAgentAnalysis> = {
    runId,
    tenantId: report.tenantId,
    environment: report.environment,
    strategyName: STRATEGY_NAME,
    systemPrompt,
    userPrompt,
    responseSchema: CrossAgentAnalysisSchema,
    maxTokens,
  };

  return engine.reason(request);
}
