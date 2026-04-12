import React from 'react';
import { Box, Text } from 'ink';
import { DinoHeader } from '../ink/DinoHeader';
import { StatusIcon } from '../ink/StatusIcon';
import { NextStep } from '../ink/NextStep';

export interface ValidateViewProps {
  version: string;
  success: boolean;
  message?: string;
  colored?: boolean;
}

export function ValidateView({
  version,
  success,
  message,
  colored = true,
}: ValidateViewProps): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      <DinoHeader version={version} command="validate" colored={colored} />
      <Box flexDirection="row" gap={1}>
        <StatusIcon status={success ? 'success' : 'error'} colored={colored} />
        <Text>{message ?? (success ? 'Config valid' : 'Config invalid')}</Text>
      </Box>
      {success ? <NextStep text="Next:" command="dino scan" colored={colored} /> : null}
    </Box>
  );
}
