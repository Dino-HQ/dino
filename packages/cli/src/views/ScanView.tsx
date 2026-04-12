import React from 'react';
import { Box, Text } from 'ink';
import { DinoHeader } from '../ink/DinoHeader';
import { DinoSpinner } from '../ink/DinoSpinner';
import { SummaryCard } from '../ink/SummaryCard';
import { NextStep } from '../ink/NextStep';
import { ProgressBar } from '../ink/ProgressBar';
import { DINO_THEME } from '../ink/theme';

export interface ScanViewProps {
  version: string;
  tenant: string;
  environment: string;
  operationCount: number;
  healthScore: number;
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

export function ScanView({
  version,
  tenant,
  environment,
  operationCount,
  healthScore,
  findingCount,
  toolsRun,
  breakingChanges,
  durationMs,
  degraded,
  colored = true,
}: ScanViewProps): React.ReactElement {
  const stats = [
    { label: 'OPERATIONS', value: operationCount },
    { label: 'FINDINGS', value: findingCount },
    { label: 'TOOLS RUN', value: toolsRun },
    {
      label: 'BREAKING',
      value: breakingChanges,
      color: colored && breakingChanges > 0 ? DINO_THEME.error : undefined,
    },
    { label: 'DURATION', value: formatDuration(durationMs) },
  ];
  const progress = degraded ? 0 : toolsRun > 0 ? 1 : 0;
  const spinnerText = degraded
    ? 'Pipeline degraded — all tools failed'
    : 'Pipeline complete — summary';

  return (
    <Box flexDirection="column">
      <DinoHeader
        version={version}
        command="scan"
        tenant={tenant}
        environment={environment}
        colored={colored}
      />
      <DinoSpinner text={spinnerText} colored={colored} />
      <Box marginY={1}>
        <ProgressBar ratio={progress} width={24} label="Tools completing" colored={colored} />
      </Box>
      <SummaryCard
        title="Scan results"
        healthScore={degraded ? undefined : healthScore}
        stats={stats}
        colored={colored}
      />
      {degraded ? (
        <Box marginTop={1}>
          <Text color={colored ? DINO_THEME.warning : undefined}>
            {'\u26A0'} Degraded — all tools failed. Health score unavailable.
          </Text>
        </Box>
      ) : null}
      <NextStep text="Next:" command="dino watch --once" colored={colored} />
    </Box>
  );
}
