import React from 'react';
import { Box, Text } from 'ink';
import { DinoHeader } from '../ink/DinoHeader';
import { Divider } from '../ink/Divider';

export interface InitViewProps {
  version: string;
  lines: string[];
  colored?: boolean;
}

/** Styled completion summary for dino init (non-interactive presentation). */
export function InitView({ version, lines, colored = true }: InitViewProps): React.ReactElement {
  return (
    <Box flexDirection="column" gap={0}>
      <DinoHeader version={version} command="init" colored={colored} />
      <Divider title="Setup complete" colored={colored} />
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
