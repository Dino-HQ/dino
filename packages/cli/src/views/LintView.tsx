import { Box } from 'ink';
import React from 'react';
import { DinoHeader } from '../ink/DinoHeader';
import { FindingsTable } from '../ink/FindingsTable';
import { SummaryCard } from '../ink/SummaryCard';
import type { FindingRow } from '../ink/FindingsTable';

export interface LintViewProps {
  version: string;
  tenant: string;
  environment: string;
  totalOperations: number;
  documentedPercent: number;
  regressionCount: number;
  findings: FindingRow[];
  colored?: boolean;
}

export function LintView({
  version,
  tenant,
  environment,
  totalOperations,
  documentedPercent,
  regressionCount,
  findings,
  colored = true,
}: LintViewProps): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      <DinoHeader
        version={version}
        command="lint"
        tenant={tenant}
        environment={environment}
        colored={colored}
      />
      <SummaryCard
        title="Description audit"
        stats={[
          { label: 'OPERATIONS', value: totalOperations },
          {
            label: 'DOCUMENTED %',
            value: `${Number.isFinite(documentedPercent) ? documentedPercent.toFixed(1) : '0.0'}%`,
          },
          { label: 'REGRESSIONS', value: regressionCount },
        ]}
        colored={colored}
      />
      {findings.length > 0 ? <FindingsTable findings={findings} colored={colored} /> : null}
    </Box>
  );
}
