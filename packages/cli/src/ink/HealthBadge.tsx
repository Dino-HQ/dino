import { Box, Text } from 'ink';
import React from 'react';
import { DINO_THEME } from './theme';
import type { EnvelopeSeverityLevel } from '@dino/core';

export type HealthVerdictLabel = 'Critical' | 'At risk' | 'Needs attention' | 'Healthy' | 'Untested';

export interface HealthBadgeProps {
  /** The canonical health verdict (`verdict.health.verdict`) — the badge renders it, never recomputes it. */
  verdict: HealthVerdictLabel;
  /** `verdict.health.score`; `null` (withheld) prints no number. */
  score?: number | null | undefined;
  /** `verdict.health.level`, colours the pill. */
  level?: EnvelopeSeverityLevel | undefined;
  colored?: boolean | undefined;
}

function colorForLevel(level: EnvelopeSeverityLevel | undefined): string {
  if (level === 'CRITICAL' || level === 'HIGH') return DINO_THEME.error;
  if (level === 'MEDIUM' || level === 'LOW') return DINO_THEME.warning;
  if (level === 'CLEAN') return DINO_THEME.success;
  return DINO_THEME.dim;
}

/** Health pill: the verdict is the label, the score (when present) supports it. UX Language §4.1. */
export function HealthBadge({ verdict, score, level, colored = true }: HealthBadgeProps): React.ReactElement {
  const text = score === null || score === undefined || !Number.isFinite(score) ? verdict : `${verdict} (${Math.round(score)})`;
  const hex = colorForLevel(level);
  return (
    <Box borderStyle="round" paddingX={1} paddingY={0}>
      {colored ? <Text color={hex}>{text}</Text> : <Text>{text}</Text>}
    </Box>
  );
}
