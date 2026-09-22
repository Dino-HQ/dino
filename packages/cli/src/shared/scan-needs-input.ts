/**
 * #2268 - dino scan NeedsInputError descriptor + resume args (HAR Slice 1).
 * @internal Tested via scan.needs-input.contract.test.ts.
 */

import type { AskUserInput } from './errors';

/** Minimal scan-flag surface used to echo already-provided args into resume. */
export interface ScanResumeFlags {
  tenant?: string | undefined;
  env?: string | undefined;
  endpoint?: string | undefined;
  protocol?: string | undefined;
  specUrl?: string | undefined;
  format?: string | undefined;
  snapshotDir?: string | undefined;
  modules?: string[] | undefined;
  tools?: string[] | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  debug?: boolean | undefined;
  noColor?: boolean | undefined;
  failOnHigh?: boolean | undefined;
  acceptPartial?: boolean | undefined;
}

/** Endpoint input when scan cannot resolve a target URL from tenant config. */
export const SCAN_ENDPOINT_DESCRIPTOR: AskUserInput = {
  field: 'endpoint',
  flag: '--endpoint',
  envVar: 'DINO_ENDPOINT',
  description: 'The API base URL to scan',
  secret: false,
  reason:
    'dino scan needs an API URL. This tenant has no resolvable endpoint for the selected environment.',
  example: 'https://api.example.com/graphql',
};

function pushPair(args: string[], flag: string, value: string | undefined): void {
  if (value === undefined) return;
  args.push(flag, value);
}

function pushBool(args: string[], flag: string, value: boolean | undefined): void {
  if (value === true) args.push(flag);
}

/**
 * Build `resume.args` for a scan NeedsInputError (#2268).
 *
 * LATENT-INVARIANT (ADR 2026-08-20-har-resume-model.md): echo-all is safe ONLY because no flag
 * carries a raw secret value. Scan's `--token`, `--header`, and `--ai-key` CAN carry secrets /
 * credentials, so they are filtered out of resume.args here. If another value-carrying secret
 * flag is added, filter it here too.
 */
export function resumeArgsForScan(flags: ScanResumeFlags): string[] {
  const args: string[] = ['scan'];
  pushPair(args, '--tenant', flags.tenant);
  pushPair(args, '--env', flags.env);
  pushPair(args, '--endpoint', flags.endpoint);
  pushPair(args, '--protocol', flags.protocol);
  pushPair(args, '--spec-url', flags.specUrl);
  pushPair(args, '--format', flags.format);
  pushPair(args, '--snapshot-dir', flags.snapshotDir);
  if (flags.modules !== undefined && flags.modules.length > 0) {
    args.push('--modules', flags.modules.join(','));
  }
  if (flags.tools !== undefined && flags.tools.length > 0) {
    args.push('--tools', flags.tools.join(','));
  }
  pushBool(args, '--quiet', flags.quiet);
  pushBool(args, '--verbose', flags.verbose);
  pushBool(args, '--debug', flags.debug);
  pushBool(args, '--no-color', flags.noColor);
  pushBool(args, '--fail-on-high', flags.failOnHigh);
  pushBool(args, '--accept-partial', flags.acceptPartial);
  // Intentionally omitted (value-carrying / secret): --token, --header
  return args;
}
