/** An HTTP response arrived, but could not be interpreted by the executor. Status and headers are
 *  still evidence (rate-limit headers, 429/401/5xx semantics) and travel with the error. */
export class ExecutorHttpError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(message: string, options: ErrorOptions & { status: number; headers?: Record<string, string> }) {
    super(message, options);
    this.name = 'ExecutorHttpError';
    this.status = options.status;
    this.headers = options.headers ?? {};
  }
}

/** Target validation rejected the request before transport began. */
export class ExecutorBlockedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExecutorBlockedError';
  }
}

/** The engine's deadline prevented a transport start, not an API verdict. */
export class TransportDeadlineExceededError extends Error {
  constructor() {
    super('Transport deadline exceeded');
    this.name = 'TransportDeadlineExceededError';
  }
}
