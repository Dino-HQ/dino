import { Box, Text } from 'ink';
import React from 'react';
import { DinoHeader } from '../ink/DinoHeader';
import { Divider } from '../ink/Divider';
import { NextStep } from '../ink/NextStep';
import { SummaryCard } from '../ink/SummaryCard';
import { DINO_THEME } from '../ink/theme';

export interface WatchIterationViewProps {
  version: string;
  tenant: string;
  environment: string;
  iteration: number;
  healthScore: number | null;
  operationCount: number;
  toolsRun: number;
  toolsCompleted: number;
  toolsFailed: number;
  breakingChanges: number;
  durationMs: number;
  degraded: boolean;
  nextScanInSec?: number | undefined;
  colored?: boolean | undefined;
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

function buildIterationStats(props: {
  operationCount: number;
  toolsRun: number;
  toolsCompleted: number;
  toolsFailed: number;
  breakingChanges: number;
  durationMs: number;
  colored: boolean;
}) {
  return [
    { label: 'OPERATIONS', value: props.operationCount },
    { label: 'TOOLS RUN', value: props.toolsRun },
    { label: 'COMPLETED', value: props.toolsCompleted },
    {
      label: 'FAILED',
      value: props.toolsFailed,
      color: props.colored && props.toolsFailed > 0 ? DINO_THEME.error : undefined,
    },
    {
      label: 'BREAKING',
      value: props.breakingChanges,
      color: props.colored && props.breakingChanges > 0 ? DINO_THEME.error : undefined,
    },
    { label: 'DURATION', value: formatDuration(props.durationMs) },
  ];
}

function NextScanCountdown({
  nextScanInSec,
  colored,
}: Readonly<{
  nextScanInSec: number | undefined;
  colored: boolean;
}>): React.ReactElement | null {
  if (nextScanInSec === undefined) return null;
  const label = `Next scan in ${formatCountdown(nextScanInSec)} \u2014 Ctrl+C to stop`;
  return (
    <Box marginTop={1} borderStyle="round" paddingX={1}>
      {colored ? <Text dimColor>{label}</Text> : <Text>{label}</Text>}
    </Box>
  );
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
  const title = `ITERATION ${String(iteration)} \u2014 ${environment.toUpperCase()}`;
  const stats = buildIterationStats({
    operationCount,
    toolsRun,
    toolsCompleted,
    toolsFailed,
    breakingChanges,
    durationMs,
    colored,
  });

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
      {degraded && (
        <Box marginTop={1}>
          <Text {...(colored ? { color: DINO_THEME.warning } : {})}>
            {'\u26A0'} Degraded \u2014 all tools failed. Health score unavailable.
          </Text>
        </Box>
      )}
      <NextScanCountdown nextScanInSec={nextScanInSec} colored={colored} />
      <NextStep text="Next:" command="dino scan" colored={colored} />
    </Box>
  );
}
