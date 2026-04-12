import React from 'react';
import { Box, Text } from 'ink';
import { DINO_THEME } from './theme';

const DINO_ASCII = ['  ▟██▙ ▄', '  █ ●██▀', '  ▜██▛▀ '];

export interface DinoHeaderProps {
  version: string;
  command: string;
  tenant?: string;
  environment?: string;
  extra?: Record<string, string>;
  colored?: boolean;
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
        {DINO_ASCII.map((line, i) => (
          <Text key={i} color={colored ? DINO_THEME.brand : undefined}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Box gap={1} flexDirection="row">
          <Text bold={colored} color={colored ? DINO_THEME.brand : undefined}>
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
        {(tenant !== undefined || environment !== undefined || extra) && (
          <Box gap={2} marginTop={1} flexDirection="row" flexWrap="wrap">
            {tenant !== undefined ? (
              colored ? (
                <Text dimColor color={DINO_THEME.dim}>
                  tenant: <Text color={DINO_THEME.muted}>{tenant}</Text>
                </Text>
              ) : (
                <Text>tenant: {tenant}</Text>
              )
            ) : null}
            {environment !== undefined ? (
              colored ? (
                <Text dimColor color={DINO_THEME.dim}>
                  env: <Text color={DINO_THEME.muted}>{environment}</Text>
                </Text>
              ) : (
                <Text>env: {environment}</Text>
              )
            ) : null}
            {extra
              ? Object.entries(extra).map(([k, v]) =>
                  colored ? (
                    <Text key={k} dimColor color={DINO_THEME.dim}>
                      {k}: <Text color={DINO_THEME.muted}>{v}</Text>
                    </Text>
                  ) : (
                    <Text key={k}>
                      {k}: {v}
                    </Text>
                  ),
                )
              : null}
          </Box>
        )}
      </Box>
      <Box flexGrow={1} />
      {colored ? <Text color={DINO_THEME.info}>dino {command}</Text> : <Text>dino {command}</Text>}
    </Box>
  );
}
