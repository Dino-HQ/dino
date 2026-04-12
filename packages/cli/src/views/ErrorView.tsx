import React from 'react';
import { Box } from 'ink';
import { DinoHeader } from '../ink/DinoHeader';
import { ErrorPanel } from '../ink/ErrorPanel';
import { CliError } from '../shared/errors';

export interface ErrorViewProps {
  version: string;
  command: string;
  error: Error;
  debug?: boolean;
  colored?: boolean;
}

export function ErrorView({
  version,
  command,
  error,
  debug,
  colored = true,
}: ErrorViewProps): React.ReactElement {
  const hint = error instanceof CliError ? error.hint : undefined;
  return (
    <Box flexDirection="column" gap={1}>
      <DinoHeader version={version} command={command} colored={colored} />
      <ErrorPanel error={error} hint={hint} debug={debug} colored={colored} />
    </Box>
  );
}
