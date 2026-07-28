import { Box, Text } from 'ink';
import React from 'react';
import { DINO_THEME } from './theme';

const BLOCKS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

export interface ProgressBarProps {
  ratio: number;
  width: number;
  label?: string;
  colored?: boolean;
}

/** Unicode block progress (0–1 ratio). */
export function ProgressBar({
  ratio,
  width,
  label,
  colored = true,
}: ProgressBarProps): React.ReactElement {
  const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const rawW = Math.floor(width);
  const w = Number.isFinite(rawW) ? Math.max(1, rawW) : 1;
  const filled = r * w;
  const full = Math.floor(filled);
  const frac = filled - full;
  let bar = '';
  for (let i = 0; i < full; i++) {
    bar += '█';
  }
  if (full < w && frac > 0) {
    const idx = Math.min(BLOCKS.length - 1, Math.max(0, Math.floor(frac * BLOCKS.length)));
    bar += BLOCKS[idx] ?? '█'; // eslint-disable-line security/detect-object-injection
  }
  for (let i = bar.length; i < w; i++) {
    bar += '░';
  }

  return (
    <Box flexDirection="column" gap={0}>
      {label ? (
        colored ? (
          <Text dimColor color={DINO_THEME.muted}>
            {label}
          </Text>
        ) : (
          <Text>{label}</Text>
        )
      ) : null}
      <Box flexDirection="row">
        {colored ? <Text color={DINO_THEME.success}>{bar}</Text> : <Text>{bar}</Text>}
      </Box>
    </Box>
  );
}
