import { Text } from 'ink';
import React from 'react';
import { DINO_THEME } from './theme';

export type StatusKind = 'success' | 'error' | 'warning' | 'info' | 'pending';

export interface StatusIconProps {
  status: StatusKind;
  colored?: boolean;
}

const GLYPH: Record<StatusKind, string> = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
  pending: '○',
};

const COLOR: Record<StatusKind, string> = {
  success: DINO_THEME.success,
  error: DINO_THEME.error,
  warning: DINO_THEME.warning,
  info: DINO_THEME.info,
  pending: DINO_THEME.muted,
};

export function StatusIcon({ status, colored = true }: StatusIconProps): React.ReactElement {
  const g = GLYPH[status]; // eslint-disable-line security/detect-object-injection
  const c = COLOR[status]; // eslint-disable-line security/detect-object-injection
  return colored ? <Text color={c}>{g}</Text> : <Text>{g}</Text>;
}
