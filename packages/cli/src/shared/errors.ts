/**
 * @dino/cli — CLI-specific error with exit code, optional hint, and optional cause.
 */

/** CLI-specific error with exit code and optional user-facing hint. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
    public readonly hint?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
    if (cause !== undefined) {
      // ES2022 Error.cause — preserves the original error for DEBUG=1 surfaces and tooling.
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}
