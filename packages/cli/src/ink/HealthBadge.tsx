import React from 'react';
import { Box, Text } from 'ink';
import { DINO_THEME } from './theme';

function clampScore(score: number): number {
  const rounded = Math.round(score);
  if (!Number.isFinite(rounded)) {
    return 0;
  }
  return Math.max(0, Math.min(100, rounded));
}

export interface HealthBadgeProps {
  score: number;
  colored?: boolean;
}

/** Colored health score pill (≥80 green, 50–79 yellow, &lt;50 red). */
export function HealthBadge({ score, colored = true }: HealthBadgeProps): React.ReactElement {
  const clamped = clampScore(score);
  let label: string;
  let hex: string;

  if (clamped >= 80) {
    label = 'Healthy';
    hex = DINO_THEME.success;
  } else if (clamped >= 50) {
    label = 'Needs attention';
    hex = DINO_THEME.warning;
  } else {
    label = 'Critical';
    hex = DINO_THEME.error;
  }

  const text = `${label} (${clamped})`;
  return (
    <Box borderStyle="round" paddingX={1} paddingY={0}>
      {colored ? <Text color={hex}>{text}</Text> : <Text>{text}</Text>}
    </Box>
  );
}
