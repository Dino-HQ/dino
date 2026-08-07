import { Box, Text } from 'ink';
import React from 'react';
import { DinoSpinner } from '../ink/DinoSpinner';
import { NextStep } from '../ink/NextStep';
import { ProgressBar } from '../ink/ProgressBar';
import { SummaryCard } from '../ink/SummaryCard';
import { DINO_THEME } from '../ink/theme';
import type { EnvelopeSeverityLevel } from '@dino/core';
import type { HealthVerdict } from '@dino/engine';

export interface ScanViewProps {
  operationCount: number;
  healthScore: number | null;
  healthVerdict?: HealthVerdict | undefined;
  healthLevel?: EnvelopeSeverityLevel | undefined;
  findingCount: number;
  toolsRun: number;
  breakingChanges: number;
  durationMs: number;
  degraded: boolean;
  colored?: boolean;
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
  operationCount: number;
  findingCount: number;
  toolsRun: number;
  breakingChanges: number;
  durationMs: number;
  colored: boolean;
}): Array<{ label: string; value: string | number; color?: string | undefined }> {
  const breaking: { label: string; value: string | number; color?: string | undefined } = {
    label: 'BREAKING',
    value: opts.breakingChanges,
  };
  if (opts.colored && opts.breakingChanges > 0) {
    breaking.color = DINO_THEME.error;
  }
  return [
    { label: 'OPERATIONS', value: opts.operationCount },
    { label: 'FINDINGS', value: opts.findingCount },
    { label: 'TOOLS RUN', value: opts.toolsRun },
    breaking,
    { label: 'DURATION', value: formatDuration(opts.durationMs) },
  ];
}

export function ScanView({
  operationCount,
  healthScore,
  healthVerdict,
  healthLevel,
  findingCount,
  toolsRun,
  breakingChanges,
  durationMs,
  degraded,
  colored = true,
}: ScanViewProps): React.ReactElement {
  const stats = buildScanStats({
    operationCount,
    findingCount,
    toolsRun,
    breakingChanges,
    durationMs,
    colored,
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
