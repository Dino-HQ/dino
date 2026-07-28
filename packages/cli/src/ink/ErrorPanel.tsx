import { Box, Text } from 'ink';
import React from 'react';
import { DINO_THEME } from './theme';

export interface ErrorPanelProps {
  error: Error;
  hint?: string | undefined;
  debug?: boolean | undefined;
  colored?: boolean | undefined;
}

export function ErrorPanel({
  error,
  hint,
  debug,
  colored = true,
}: ErrorPanelProps): React.ReactElement {
  const msg = error.message;
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      {...(colored ? { borderLeftColor: DINO_THEME.error } : {})}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <Box flexDirection="row" gap={1}>
        <Text {...(colored ? { color: DINO_THEME.error } : {})}>✗</Text>
        {colored ? <Text color={DINO_THEME.error}>{msg}</Text> : <Text>{msg}</Text>}
      </Box>
      {hint ? (
        colored ? (
          <Text dimColor color={DINO_THEME.dim}>
            {hint}
          </Text>
        ) : (
          <Text>{hint}</Text>
        )
      ) : null}
      {debug && error.stack ? (
        colored ? (
          <Text dimColor color={DINO_THEME.dim}>
            {error.stack}
          </Text>
        ) : (
          <Text>{error.stack}</Text>
        )
      ) : null}
    </Box>
  );
}
