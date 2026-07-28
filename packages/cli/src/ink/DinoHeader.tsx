import { Box, Text } from 'ink';
import React from 'react';
import { DINO_THEME } from './theme';

const DINO_ASCII = ['  ▟██▙ ▄', '  █ ●██▀', '  ▜██▛▀ '];

export interface DinoHeaderProps {
  version: string;
  command: string;
  tenant?: string | undefined;
  environment?: string | undefined;
  extra?: Record<string, string> | undefined;
  colored?: boolean | undefined;
}

function HeaderLabel({
  label,
  value,
  colored,
}: Readonly<{
  label: string;
  value: string;
  colored: boolean;
}>): React.ReactElement {
  if (colored) {
    return (
      <Text dimColor color={DINO_THEME.dim}>
        {label}: <Text color={DINO_THEME.muted}>{value}</Text>
      </Text>
    );
  }
  return (
    <Text>
      {label}: {value}
    </Text>
  );
}

function HeaderMeta({
  tenant,
  environment,
  extra,
  colored,
}: Readonly<{
  tenant?: string | undefined;
  environment?: string | undefined;
  extra?: Record<string, string> | undefined;
  colored: boolean;
}>): React.ReactElement | null {
  if (tenant === undefined && environment === undefined && !extra) return null;
  return (
    <Box gap={2} marginTop={1} flexDirection="row" flexWrap="wrap">
      {tenant ? <HeaderLabel label="tenant" value={tenant} colored={colored} /> : null}
      {environment ? <HeaderLabel label="env" value={environment} colored={colored} /> : null}
      {extra
        ? Object.entries(extra).map(([k, v]) => (
            <HeaderLabel key={k} label={k} value={v} colored={colored} />
          ))
        : null}
    </Box>
  );
}

export function DinoHeader({
  version,
  command,
  tenant,
  environment,
  extra,
  colored = true,
}: DinoHeaderProps): React.ReactElement {
  const ver = version ?? '';
  return (
    <Box flexDirection="row" gap={2} paddingBottom={1}>
      <Box flexDirection="column">
        {DINO_ASCII.map((line) => (
          <Text key={line} {...(colored ? { color: DINO_THEME.brand } : {})}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Box gap={1} flexDirection="row">
          <Text bold={colored} {...(colored ? { color: DINO_THEME.brand } : {})}>
            DINO
          </Text>
          {colored ? (
            <Text dimColor color={DINO_THEME.dim}>
              v{ver}
            </Text>
          ) : (
            <Text>v{ver}</Text>
          )}
        </Box>
        {colored ? (
          <Text dimColor color={DINO_THEME.dim}>
            API Intelligence Layer
          </Text>
        ) : (
          <Text>API Intelligence Layer</Text>
        )}
        <HeaderMeta tenant={tenant} environment={environment} extra={extra} colored={colored} />
      </Box>
      <Box flexGrow={1} />
      {colored ? <Text color={DINO_THEME.info}>dino {command}</Text> : <Text>dino {command}</Text>}
    </Box>
  );
}
