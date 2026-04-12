import React from 'react';
import { Box, Text } from 'ink';
import { DinoHeader } from '../ink/DinoHeader';
import { Divider } from '../ink/Divider';
import { SummaryCard } from '../ink/SummaryCard';
import { NextStep } from '../ink/NextStep';
import { DINO_THEME } from '../ink/theme';

export interface WatchIterationViewProps {
  version: string;
  tenant: string;
  environment: string;
  iteration: number;
  healthScore: number;
  operationCount: number;
  toolsRun: number;
  toolsCompleted: number;
  toolsFailed: number;
  breakingChanges: number;
  durationMs: number;
  degraded: boolean;
  nextScanInSec?: number;
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

function formatCountdown(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) {
    return '0s';
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${String(m)}m ${String(s)}s` : `${String(s)}s`;
}

export function WatchIterationView({
  version,
  tenant,
  environment,
  iteration,
  healthScore,
  operationCount,
  toolsRun,
  toolsCompleted,
  toolsFailed,
  breakingChanges,
  durationMs,
  degraded,
  nextScanInSec,
  colored = true,
}: WatchIterationViewProps): React.ReactElement {
  const title = `ITERATION ${String(iteration)} — ${environment.toUpperCase()}`;
  const stats = [
    { label: 'OPERATIONS', value: operationCount },
    { label: 'TOOLS RUN', value: toolsRun },
    { label: 'COMPLETED', value: toolsCompleted },
    {
      label: 'FAILED',
      value: toolsFailed,
      color: colored && toolsFailed > 0 ? DINO_THEME.error : undefined,
    },
    {
      label: 'BREAKING',
      value: breakingChanges,
      color: colored && breakingChanges > 0 ? DINO_THEME.error : undefined,
    },
    { label: 'DURATION', value: formatDuration(durationMs) },
  ];

  return (
    <Box flexDirection="column">
      <DinoHeader
        version={version}
        command="watch"
        tenant={tenant}
        environment={environment}
        colored={colored}
      />
      <Divider title={title} colored={colored} />
      <SummaryCard
        title="Watch"
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
      {nextScanInSec !== undefined ? (
        <Box marginTop={1} borderStyle="round" paddingX={1}>
          {colored ? (
            <Text dimColor>Next scan in {formatCountdown(nextScanInSec)} — Ctrl+C to stop</Text>
          ) : (
            <Text>Next scan in {formatCountdown(nextScanInSec)} — Ctrl+C to stop</Text>
          )}
        </Box>
      ) : null}
      <NextStep text="Next:" command="dino scan" colored={colored} />
    </Box>
  );
}
