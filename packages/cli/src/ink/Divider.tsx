import { Box, Text } from 'ink';
import React from 'react';
import { DINO_THEME } from './theme';

export interface DividerProps {
  title?: string;
  colored?: boolean;
}

export function Divider({ title, colored = true }: DividerProps): React.ReactElement {
  const line = title ? `──── ${title} ────` : '────────────────';
  return (
    <Box marginY={1}>
      {colored ? (
        <Text dimColor color={DINO_THEME.dim}>
          {line}
        </Text>
      ) : (
        <Text>{line}</Text>
      )}
    </Box>
  );
}
