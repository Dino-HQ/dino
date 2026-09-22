import { Box, Text } from 'ink';
import React from 'react';
import { DinoSpinner } from '../ink/DinoSpinner';
import { NextStep } from '../ink/NextStep';
import { ProgressBar } from '../ink/ProgressBar';
import { SummaryCard } from '../ink/SummaryCard';
import { DINO_THEME } from '../ink/theme';
import type { EnvelopeSeverityLevel } from '@dino/core';
import type { HealthVerdictLabel as HealthVerdict } from '../ink/HealthBadge';

export interface ScanViewProps {
  /** `verdict.operationCount` — `null` under an UNKNOWN scope prints `?`, never 0. */
  operationCount: number | null;
  healthScore: number | null;
  healthVerdict?: HealthVerdict | undefined;
  healthLevel?: EnvelopeSeverityLevel | undefined;
  findingCount: number;
  toolsRun: number;
  /** #196 — from the single derived tool ledger (INV-6). */
  toolsExcluded?: number | undefined;
  toolsUnavailable?: number | undefined;
  durationMs: number;
  degraded: boolean;
  colored?: boolean;
  /** `verdict.coverage === 'partial'`: the verification was incomplete for any of the verdict's reasons. */
  partial?: boolean | undefined;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildScanStats(opts: {
  operationCount: number | null;
  findingCount: number;
  toolsRun: number;
  toolsExcluded: number;
  toolsUnavailable: number;
  durationMs: number;
}): Array<{ label: string; value: string | number; color?: string | undefined }> {
  const stats: Array<{ label: string; value: string | number; color?: string | undefined }> = [
    { label: 'OPERATIONS', value: opts.operationCount ?? '?' },
    { label: 'FINDINGS', value: opts.findingCount },
    { label: 'TOOLS RUN', value: opts.toolsRun },
    { label: 'DURATION', value: formatDuration(opts.durationMs) },
  ];
  if (opts.toolsExcluded > 0 || opts.toolsUnavailable > 0) {
    stats.push({
      label: 'TOOLS SKIPPED',
      value: `${opts.toolsExcluded} excluded, ${opts.toolsUnavailable} unavailable`,
    });
  }
  return stats;
}

export function ScanView({
  operationCount,
  healthScore,
  healthVerdict,
  healthLevel,
  findingCount,
  toolsRun,
  toolsExcluded = 0,
  toolsUnavailable = 0,
  durationMs,
  degraded,
  colored = true,
  partial = false,
}: ScanViewProps): React.ReactElement {
  const stats = buildScanStats({
    operationCount,
    findingCount,
    toolsRun,
    toolsExcluded,
    toolsUnavailable,
    durationMs,
  });
  const progress = degraded ? 0 : toolsRun > 0 ? 1 : 0;
  const spinnerText = degraded ? 'All agents failed' : 'Test complete';

  return (
    <Box flexDirection="column">
      <DinoSpinner text={spinnerText} colored={colored} />
      <Box marginY={1}>
        <ProgressBar ratio={progress} width={24} label="Testing" colored={colored} />
      </Box>
      <SummaryCard
        title="Test results"
        healthScore={degraded ? undefined : healthScore}
        healthVerdict={degraded ? undefined : healthVerdict}
        healthLevel={degraded ? undefined : healthLevel}
        stats={stats}
        colored={colored}
      />
      {partial && (
        <Box marginTop={1}>
          <Text dimColor={colored}>Partial coverage: verification was incomplete</Text>
        </Box>
      )}
      {degraded && (
        <Box marginTop={1}>
          <Text {...(colored ? { color: DINO_THEME.warning } : {})}>
            {'\u26A0'} Degraded: all agents failed. No test data was produced.
          </Text>
        </Box>
      )}
      <NextStep text="Next:" command="dino watch --once" colored={colored} />
    </Box>
  );
}
