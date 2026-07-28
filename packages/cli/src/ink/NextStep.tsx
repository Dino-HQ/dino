import { Box, Text } from 'ink';
import React from 'react';
import { DINO_THEME } from './theme';

export interface NextStepProps {
  text: string;
  command: string;
  colored?: boolean;
}

/** Dim “Next:” line with highlighted command fragment. */
export function NextStep({ text, command, colored = true }: NextStepProps): React.ReactElement {
  return (
    <Box marginTop={1}>
      {colored ? (
        <Text dimColor color={DINO_THEME.dim}>
          {text}
          <Text color={DINO_THEME.muted}> {command}</Text>
        </Text>
      ) : (
        <Text>
          {text} {command}
        </Text>
      )}
    </Box>
  );
}
