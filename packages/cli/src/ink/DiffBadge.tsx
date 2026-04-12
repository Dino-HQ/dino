import React from 'react';
import { Box, Text } from 'ink';
import { DINO_THEME } from './theme';

export type DiffBadgeType = 'added' | 'removed' | 'modified' | 'breaking';

export interface DiffBadgeProps {
  count: number;
  type: DiffBadgeType;
  colored?: boolean;
}

const PREFIX: Record<DiffBadgeType, string> = {
  added: '+',
  removed: '-',
  modified: '~',
  breaking: '!',
};

const COLOR: Record<DiffBadgeType, string> = {
  added: DINO_THEME.success,
  removed: DINO_THEME.error,
  modified: DINO_THEME.info,
  breaking: DINO_THEME.warning,
};

const LABEL: Record<DiffBadgeType, string> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  breaking: 'breaking',
};

export function DiffBadge({ count, type, colored = true }: DiffBadgeProps): React.ReactElement {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const text = `${PREFIX[type]}${String(n)} ${LABEL[type]}`; // eslint-disable-line security/detect-object-injection
  const hex = COLOR[type]; // eslint-disable-line security/detect-object-injection
  return (
    <Box marginRight={1}>{colored ? <Text color={hex}>{text}</Text> : <Text>{text}</Text>}</Box>
  );
}
