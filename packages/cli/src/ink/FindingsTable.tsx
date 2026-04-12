import React from 'react';
import { Box, Text } from 'ink';
import { DINO_THEME } from './theme';

export interface FindingRow {
  severity: string;
  message: string;
  operation?: string;
}

export interface FindingsTableProps {
  findings: FindingRow[];
  colored?: boolean;
}

function severityColor(sev: string): string | undefined {
  const u = sev.toUpperCase();
  if (u.includes('CRITICAL')) return DINO_THEME.error;
  if (u.includes('HIGH')) return DINO_THEME.error;
  if (u.includes('MEDIUM')) return DINO_THEME.warning;
  if (u.includes('LOW')) return DINO_THEME.info;
  return DINO_THEME.muted;
}

export function FindingsTable({
  findings,
  colored = true,
}: FindingsTableProps): React.ReactElement {
  return (
    <Box flexDirection="column" gap={0}>
      {findings.map((f, i) => {
        const c = colored ? severityColor(f.severity) : undefined;
        const op = f.operation ? `${f.operation} · ` : '';
        return (
          <Box key={i} flexDirection="row" gap={1}>
            {colored && c ? <Text color={c}>{f.severity}</Text> : <Text>{f.severity}</Text>}
            <Text>
              {op}
              {f.message}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
