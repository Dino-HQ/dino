import { Box, Text } from 'ink';
import React from 'react';
import { HealthBadge } from './HealthBadge';
import { DINO_THEME } from './theme';

export interface SummaryStat {
  label: string;
  value: string | number;
  color?: string | undefined;
}

export interface SummaryCardProps {
  title: string;
  healthScore?: number | undefined;
  stats: SummaryStat[];
  colored?: boolean | undefined;
}

export function SummaryCard({
  title,
  healthScore,
  stats,
  colored = true,
}: SummaryCardProps): React.ReactElement {
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
        {healthScore !== undefined ? <HealthBadge score={healthScore} colored={colored} /> : null}
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
