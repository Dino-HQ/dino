/**
 * @dino/cli — CLI-specific error with exit code, optional hint, and optional cause.
 */

import type { OutcomeKind } from './outcome';

export type CliErrorRetryable = 'transient' | 'permanent';

export interface CliErrorOptions {
  exitCode?: number;
  hint?: string;
  cause?: unknown;
  kind?: OutcomeKind;
  retryable?: CliErrorRetryable;
}

/**
 * CLI-specific error with exit code and optional user-facing hint.
 * Positional constructor kept for the 7+ callers that pass `cause` as the 4th arg (#2173).
 * New `kind`/`retryable` MUST stay after `cause` (positions 5/6).
 */
export class CliError extends Error {
  public readonly exitCode: number;
  public readonly hint?: string;
  public readonly kind?: OutcomeKind;
  public readonly retryable: CliErrorRetryable;

  // Spec #2173: kind/retryable AFTER cause — exceeds max-params by design (positional compat).
  // eslint-disable-next-line @typescript-eslint/max-params -- handover requires positions 5/6 after cause
  constructor(
    message: string,
    exitCode: number = 1,
    hint?: string,
    cause?: unknown,
    kind?: OutcomeKind,
    retryable: CliErrorRetryable = 'permanent',
  ) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    if (hint !== undefined) this.hint = hint;
    if (cause !== undefined) {
      // ES2022 Error.cause — preserves the original error for DEBUG=1 surfaces and tooling.
      (this as Error & { cause?: unknown }).cause = cause;
    }
    if (kind !== undefined) this.kind = kind;
    this.retryable = retryable;
  }
}
