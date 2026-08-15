/**
 * @dino/cli — Terminal UI utilities (color, spinners, structured output).
 * Issue #1013. All visual output is gated behind isInteractive.
 *
 * INV-1: Non-TTY / CI / --quiet → no ANSI codes, no spinner animation.
 * INV-4: JSON output never contains ANSI codes (callers pass non-colored ui).
 * INV-5: NO_COLOR env var disables all color.
 */

import chalk from 'chalk';
import ora from 'ora';
import { healthVerdict } from '@dino/engine';
import { DINO_ASCII, DINO_TAGLINE, DINO_BRAND_HEX } from './brand';
import { CliError } from './errors';
import { boundErrorMessage, isUpstreamClientError } from './outcome';
import type { EnvelopeSeverityLevel } from '@dino/core';
import type { Ora } from 'ora';

export interface UiOptions {
  /** True when stdout is a TTY, not CI, and not --quiet - controls spinner animation */
  interactive: boolean;
  /** True when color output is allowed (interactive AND not --no-color / NO_COLOR) */
  colored: boolean;
  /** True when --quiet is set */
  quiet: boolean;
  /** True when Ink rendering may be used (interactive TTY; dynamic import handles load failures) - #1014 */
  ink: boolean;
  /** #2143: --verbose - show extra progress notices the default path suppresses. Set by detectUi. */
  verbose?: boolean;
  /** #2143: --debug - show diagnostics + stack traces. Set by detectUi. */
  debug?: boolean;
}

/** Detect whether we're in an interactive terminal. */
export function detectUi(flags: {
  quiet?: boolean | undefined;
  noColor?: boolean | undefined;
  verbose?: boolean | undefined;
  debug?: boolean | undefined;
}): UiOptions {
  const isTTY = process.stdout.isTTY === true;
  const isCI = Boolean(process.env.CI);
  const interactive = isTTY && !isCI && !flags.quiet;
  const noColor = flags.noColor === true || Boolean(process.env.NO_COLOR);
  const colored = interactive && !noColor;
  const ink = interactive;
  return {
    interactive,
    colored,
    quiet: flags.quiet === true,
    ink,
    verbose: flags.verbose === true || flags.debug === true,
    debug: flags.debug === true,
  };
}

function createNoopOra(initialText: string): Ora {
  // Noop spinner for non-TTY — satisfies Ora interface with chainable no-ops.
  // Double cast required: Ora has 20+ properties we intentionally omit.
  const obj: Record<string, unknown> = { text: initialText };
  const chain = (): Record<string, unknown> => obj;
  for (const m of ['start', 'stop', 'succeed', 'fail', 'warn', 'info', 'clear']) {
    obj[m] = chain; // eslint-disable-line security/detect-object-injection
  }
  const result: unknown = obj;
  return result as Ora;
}

/** Spinner wrapper. Returns a no-op in non-interactive mode. */
export function createSpinner(text: string, ui: UiOptions): Ora {
  if (!ui.interactive) {
    try {
      return ora({ text, isEnabled: false, isSilent: ui.quiet });
    } catch {
      return createNoopOra(text);
    }
  }
  try {
    return ora({ text, spinner: 'dots' });
  } catch {
    return createNoopOra(text);
  }
}

export type ChalkColor = 'green' | 'red' | 'yellow' | 'blue' | 'dim' | 'bold' | 'redBold';

/** Apply chalk color only when colored is true. Plain text otherwise. */
export function colorize(text: string, color: ChalkColor, ui: UiOptions): string {
  if (!ui.colored) {
    return text;
  }
  switch (color) {
    case 'green':
      return chalk.green(text);
    case 'red':
      return chalk.red(text);
    case 'yellow':
      return chalk.yellow(text);
    case 'blue':
      return chalk.blue(text);
    case 'dim':
      return chalk.dim(text);
    case 'bold':
      return chalk.bold(text);
    case 'redBold':
      return chalk.red.bold(text);
    default: {
      const _exhaustive: never = color;
      return _exhaustive;
    }
  }
}

function clampHealthScore(score: number): number {
  const rounded = Math.round(score);
  if (!Number.isFinite(rounded)) {
    return 0;
  }
  return Math.max(0, Math.min(100, rounded));
}

/**
 * Severity-gated health label. UX Language §4.1: "The number supports the verdict — never IS the verdict."
 * Verdict comes from healthVerdict(level); score is optional display support (null → no number).
 */
export function healthLabel(
  score: number | null,
  level: EnvelopeSeverityLevel,
  ui: UiOptions,
): string {
  const verdict = healthVerdict(level);
  let color: ChalkColor;
  if (level === 'CRITICAL') {
    color = 'redBold';
  } else if (level === 'HIGH') {
    color = 'red';
  } else if (level === 'MEDIUM' || level === 'LOW') {
    color = 'yellow';
  } else if (level === 'CLEAN') {
    color = 'green';
  } else {
    color = 'dim';
  }

  const text = score === null ? verdict : `${verdict} (${clampHealthScore(score)})`;
  return colorize(text, color, ui);
}

/** Format milliseconds as human-readable duration. */
export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Print a CliError or generic Error with optional hint and debug stack trace.
 * UX Language §9: errors describe what happened + suggest next action.
 */
export function printError(err: Error, ui: UiOptions, debug?: boolean): void {
  const message = humanizeError(err);
  const hint = err instanceof CliError ? err.hint : undefined;

  console.error(colorize(`✗  ${message}`, 'red', ui));
  if (hint) {
    console.error(colorize(`   ${hint}`, 'dim', ui));
  }
  if (debug && err.stack) {
    const stackText = isUpstreamClientError(err) ? boundErrorMessage(err) : err.stack;
    console.error(colorize(stackText, 'dim', ui));
  }
}

/**
 * #201: rewrite endpoint-validation jargon at the CLI boundary.
 * Returns undefined when the message is not an endpoint-validation error.
 */
function humanizeEndpointValidationError(message: string): string | undefined {
  // All engine SSRF/DNS errors carry the literal "SSRF blocked:" prefix + a reason code.
  if (message.includes('SSRF blocked:')) {
    if (message.includes('dns_resolution_failed')) {
      return "We couldn't find that host. Check the endpoint URL for a typo and try again.";
    }
    if (
      message.includes('blocked_ipv4') ||
      message.includes('blocked_ipv6') ||
      message.includes('metadata_host') ||
      message.includes('unparseable_mapped_ip')
    ) {
      return "That endpoint points to a private or internal address, so Dino won't test it. Use a public API endpoint.";
    }
    if (message.includes('wrong_protocol')) {
      return 'The endpoint URL must start with http:// or https://.';
    }
    if (message.includes('malformed_url')) {
      return "That endpoint URL isn't valid. Example: https://api.example.com/graphql";
    }
    // Unknown/future reason code — never leak "SSRF blocked … <code>".
    return "Dino couldn't test that endpoint: it didn't pass an address safety check.";
  }
  return undefined;
}

/**
 * #174/#201: map known node/network and endpoint-validation errors to clean product text.
 * Default arm keeps the original `.message`. Never interpolates the raw error
 * object or `process.env` — map by code/name/message substrings only.
 */
export function humanizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  let code = '';
  if (err !== null && typeof err === 'object') {
    const rawCode = Reflect.get(err, 'code');
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
  }
  const haystack = `${code} ${name} ${message}`;

  const endpointMsg = humanizeEndpointValidationError(message);
  if (endpointMsg !== undefined) return endpointMsg;

  // #201: node's own malformed-URL TypeError. Anchor on the stable ERR_INVALID_URL code,
  // not a message substring, so a target API's error text can't false-match.
  if (code === 'ERR_INVALID_URL') {
    return "That endpoint URL isn't valid. Example: https://api.example.com/graphql";
  }

  if (haystack.includes('ECONNRESET') || message.includes('socket hang up')) {
    return 'The connection to the API was closed unexpectedly. Check the endpoint and your network.';
  }
  if (haystack.includes('ENOTFOUND')) {
    return "Couldn't resolve the endpoint host. Check the URL.";
  }
  if (haystack.includes('ECONNREFUSED')) {
    return 'The endpoint refused the connection. Is it running and reachable?';
  }
  if (haystack.includes('ETIMEDOUT') || name === 'AbortError' || haystack.includes('AbortError')) {
    return 'The request timed out. The endpoint may be slow or unreachable.';
  }
  if (message.includes('fetch failed')) {
    return "Couldn't reach the endpoint. Check the URL and your network.";
  }
  return boundErrorMessage(err);
}

/**
 * #2143: print a product notice to STDERR (never stdout — stdout is the result only).
 * Product voice, no timestamp, no log-level prefix. Use for user-relevant conditions the
 * default path should surface (reduced fidelity, running unauthenticated). No-ops when --quiet.
 */
export function printNotice(message: string, ui: UiOptions, opts?: { hint?: string }): void {
  if (ui.quiet) return;
  console.error(colorize(`!  ${message}`, 'yellow', ui));
  if (opts?.hint) {
    console.error(colorize(`   ${opts.hint}`, 'dim', ui));
  }
}

export interface HeaderBannerMeta {
  version: string;
  command: string;
  tenant?: string | undefined;
  environment?: string | undefined;
}

/**
 * #2143: branded start-of-run header, printed to STDERR (chrome, never stdout).
 * Interactive terminals only — suppressed when piped, redirected, in CI, or --quiet,
 * so `dino scan | jq` / `> report.md` stay pure result and logs stay clean.
 */
export function printHeaderBanner(ui: UiOptions, meta: HeaderBannerMeta): void {
  if (!ui.interactive) return;
  const brand = (s: string): string => (ui.colored ? chalk.hex(DINO_BRAND_HEX)(s) : s);
  const dim = (s: string): string => (ui.colored ? chalk.dim(s) : s);
  const bold = (s: string): string => (ui.colored ? chalk.bold(s) : s);
  const metaBits: string[] = [];
  if (meta.tenant !== undefined) {
    metaBits.push(`tenant: ${meta.tenant}`);
  }
  if (meta.environment !== undefined) {
    metaBits.push(`env: ${meta.environment}`);
  }
  metaBits.push(`dino ${meta.command}`);
  const versionText = `v${meta.version}`;
  const right = [
    `${bold('DINO')} ${dim(versionText)}`,
    dim(DINO_TAGLINE),
    dim(metaBits.join('  ')),
  ];
  const lines = DINO_ASCII.map((art, i) => `${brand(art)}   ${right.at(i) ?? ''}`);
  console.error(lines.join('\n'));
  console.error('');
}
