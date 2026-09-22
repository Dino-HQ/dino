import { Box, Text } from 'ink';
import React from 'react';
import { HealthBadge } from './HealthBadge';
import { DINO_THEME } from './theme';
import type { HealthVerdictLabel as HealthVerdict } from './HealthBadge';
import type { EnvelopeSeverityLevel } from '@dino/core';

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

function resolveHealthNode(props: {
  healthScore: number | null | undefined;
  healthVerdict: HealthVerdict | undefined;
  healthLevel: EnvelopeSeverityLevel | undefined;
  colored: boolean;
}): React.ReactNode {
  const { healthScore, healthVerdict, healthLevel, colored } = props;
  if (healthVerdict === undefined) return null;
  return <HealthBadge verdict={healthVerdict} score={healthScore} level={healthLevel} colored={colored} />;
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
