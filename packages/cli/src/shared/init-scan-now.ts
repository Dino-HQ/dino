/**
 * #2160 — "Run a scan now?" dispatch after dino init (INV-4: tenant-free ad-hoc/flat config).
 */

import { buildContext } from './base-command';
import { runScan } from '../commands/scan';
import { loadCliConfig } from '../config/loader';
import type { MergedFlags } from './base-command';

export interface InitScanNowFlags {
  quiet: boolean;
  verbose: boolean;
  debug: boolean;
  noColor: boolean;
  format: 'markdown' | 'json' | undefined;
  env: string | undefined;
  header: string | string[] | undefined;
  token: string | undefined;
}

/** Build ad-hoc context from the just-written flat config and run scan. */
export async function runInitScanNow(common: InitScanNowFlags): Promise<number> {
  const freshConfig = await loadCliConfig();
  const scanFlags = {
    tenant: '',
    env: common.env,
    format: common.format,
    quiet: common.quiet,
    verbose: common.verbose,
    debug: common.debug,
    noColor: common.noColor,
    endpoint: freshConfig?.endpoint,
    protocol: freshConfig?.protocol,
    specUrl: freshConfig?.specUrl,
    header: common.header,
    token: common.token,
  };
  const ctx = buildContext(scanFlags, freshConfig);
  try {
    const merged: MergedFlags = { ...freshConfig, ...scanFlags };
    return await runScan(ctx, merged);
  } finally {
    await ctx.tracker.shutdown();
  }
}
