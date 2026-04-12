/**
 * @dino/cli — CLI-specific error with exit code and optional hint
 */

/** CLI-specific error with exit code and optional user-facing hint. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
