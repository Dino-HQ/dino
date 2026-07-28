import { Box, Text } from 'ink';
import React from 'react';
import { DiffBadge } from '../ink/DiffBadge';
import { DinoHeader } from '../ink/DinoHeader';
import { NextStep } from '../ink/NextStep';
import { SummaryCard } from '../ink/SummaryCard';

export interface DiffViewProps {
  version: string;
  tenant: string;
  environment: string;
  added: number;
  removed: number;
  modified: number;
  breakingChanges: number;
  timeDeltaLabel?: string;
  colored?: boolean;
}

export function DiffView({
  version,
  tenant,
  environment,
  added,
  removed,
  modified,
  breakingChanges,
  timeDeltaLabel,
  colored = true,
}: DiffViewProps): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      <DinoHeader
        version={version}
        command="diff"
        tenant={tenant}
        environment={environment}
        colored={colored}
      />
      <Box flexDirection="row" flexWrap="wrap">
        <DiffBadge count={added} type="added" colored={colored} />
        <DiffBadge count={removed} type="removed" colored={colored} />
        <DiffBadge count={modified} type="modified" colored={colored} />
        <DiffBadge count={breakingChanges} type="breaking" colored={colored} />
      </Box>
      {timeDeltaLabel ? (
        colored ? (
          <Text dimColor>{timeDeltaLabel}</Text>
        ) : (
          <Text>{timeDeltaLabel}</Text>
        )
      ) : null}
      <SummaryCard
        title="Diff summary"
        stats={[
          { label: 'ADDED', value: added },
          { label: 'REMOVED', value: removed },
          { label: 'MODIFIED', value: modified },
          { label: 'BREAKING', value: breakingChanges },
        ]}
        colored={colored}
      />
      {breakingChanges > 0 ? (
        <Text>Schema has breaking changes — review before release.</Text>
      ) : null}
      <NextStep text="Next:" command="dino watch --autonomy enforce" colored={colored} />
    </Box>
  );
}
