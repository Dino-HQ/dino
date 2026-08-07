import { Box, Text } from 'ink';
import React from 'react';
import { HealthBadge } from './HealthBadge';
import { DINO_THEME } from './theme';
import type { EnvelopeSeverityLevel } from '@dino/core';
import type { HealthVerdict } from '@dino/engine';

export interface SummaryStat {
  label: string;
  value: string | number;
  color?: string | undefined;
}

export interface SummaryCardProps {
  title: string;
  healthScore?: number | null | undefined;
  healthVerdict?: HealthVerdict | undefined;
  healthLevel?: EnvelopeSeverityLevel | undefined;
  stats: SummaryStat[];
  colored?: boolean | undefined;
}

function colorForLevel(level: EnvelopeSeverityLevel | undefined): string {
  if (level === 'CRITICAL' || level === 'HIGH') return DINO_THEME.error;
  if (level === 'MEDIUM' || level === 'LOW') return DINO_THEME.warning;
  if (level === 'CLEAN') return DINO_THEME.success;
  return DINO_THEME.dim;
}

function GatedHealthLabel(props: {
  verdict: HealthVerdict;
  score: number | null | undefined;
  level: EnvelopeSeverityLevel | undefined;
  colored: boolean;
}): React.ReactElement {
  const { verdict, score, level, colored } = props;
  const text =
    score === null || score === undefined ? verdict : `${verdict} (${Math.round(score)})`;
  const hex = colorForLevel(level);
  return (
    <Box borderStyle="round" paddingX={1} paddingY={0}>
      {colored ? <Text color={hex}>{text}</Text> : <Text>{text}</Text>}
    </Box>
  );
}

function resolveHealthNode(props: {
  healthScore: number | null | undefined;
  healthVerdict: HealthVerdict | undefined;
  healthLevel: EnvelopeSeverityLevel | undefined;
  colored: boolean;
}): React.ReactNode {
  const { healthScore, healthVerdict, healthLevel, colored } = props;
  if (healthVerdict !== undefined) {
    return (
      <GatedHealthLabel
        verdict={healthVerdict}
        score={healthScore}
        level={healthLevel}
        colored={colored}
      />
    );
  }
  if (healthScore !== undefined && healthScore !== null) {
    return <HealthBadge score={healthScore} colored={colored} />;
  }
  return null;
}

export function SummaryCard({
  title,
  healthScore,
  healthVerdict,
  healthLevel,
  stats,
  colored = true,
}: SummaryCardProps): React.ReactElement {
  const healthNode = resolveHealthNode({ healthScore, healthVerdict, healthLevel, colored });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...(colored ? { borderColor: DINO_THEME.border } : {})}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="space-between" marginBottom={1} flexDirection="row">
        {colored ? (
          <Text dimColor color={DINO_THEME.dim}>
            {title.toUpperCase()}
          </Text>
        ) : (
          <Text>{title.toUpperCase()}</Text>
        )}
        {healthNode}
      </Box>
      <Box gap={4} flexWrap="wrap" flexDirection="row">
        {stats.map((s) => (
          <Box key={s.label} flexDirection="column">
            {colored && s.color ? (
              <Text bold color={s.color}>
                {String(s.value)}
              </Text>
            ) : (
              <Text bold>{String(s.value)}</Text>
            )}
            {colored ? (
              <Text dimColor color={DINO_THEME.dim}>
                {s.label}
              </Text>
            ) : (
              <Text>{s.label}</Text>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
