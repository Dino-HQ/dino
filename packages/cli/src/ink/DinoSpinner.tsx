import { Box, Text, useAnimation } from 'ink';
import React from 'react';
import { DINO_THEME } from './theme';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface DinoSpinnerProps {
  text: string;
  colored?: boolean;
}

/** Branded spinner using Ink useAnimation (no bare timers in app code). */
export function DinoSpinner({ text, colored = true }: DinoSpinnerProps): React.ReactElement {
  const { frame } = useAnimation({ interval: 80 });
  const ch = FRAMES[frame % FRAMES.length] ?? FRAMES[0];
  return (
    <Box flexDirection="row" gap={1}>
      {colored ? <Text color={DINO_THEME.info}>{ch}</Text> : <Text>{ch}</Text>}
      <Text>{text}</Text>
    </Box>
  );
}
