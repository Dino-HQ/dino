import React from 'react';
import { Box, Text } from 'ink';
import { DinoHeader } from '../ink/DinoHeader';
import { SummaryCard } from '../ink/SummaryCard';
import { DiffBadge } from '../ink/DiffBadge';

export interface ChangelogViewProps {
  version: string;
  tenant: string;
  environment: string;
  fromId: string;
  toId: string;
  added: number;
  removed: number;
  modified: number;
  breakingCount: number;
  colored?: boolean;
}

export function ChangelogView({
  version,
  tenant,
  environment,
  fromId,
  toId,
  added,
  removed,
  modified,
  breakingCount,
  colored = true,
}: ChangelogViewProps): React.ReactElement {
  const hasBreaking = breakingCount > 0;
  return (
    <Box flexDirection="column" gap={1}>
      <DinoHeader
        version={version}
        command="changelog"
        tenant={tenant}
        environment={environment}
        extra={{ from: fromId, to: toId }}
        colored={colored}
      />
      <Box flexDirection="row" flexWrap="wrap">
        <DiffBadge count={added} type="added" colored={colored} />
        <DiffBadge count={removed} type="removed" colored={colored} />
        <DiffBadge count={modified} type="modified" colored={colored} />
        {hasBreaking ? <DiffBadge count={breakingCount} type="breaking" colored={colored} /> : null}
      </Box>
      <SummaryCard
        title="Changelog"
        stats={[
          { label: 'FROM', value: fromId },
          { label: 'TO', value: toId },
        ]}
        colored={colored}
      />
      {hasBreaking ? <Text>Breaking changes detected — review migration notes.</Text> : null}
    </Box>
  );
}
