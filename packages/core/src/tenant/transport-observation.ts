/** Internal execution evidence, carried only on target-request options (never over the wire). */
export type TransportState = 'attempted' | 'not-attempted' | 'unknown';
export interface TransportObservation {
  onTransportState?: ((state: TransportState) => void) | undefined;
}
/** Engine-owned dispatch admission; unlike observation, rejection must stop transport. */
export interface TransportControl {
  beforeTransport?: (() => void) | undefined;
}
export type ObservedRequestInit = RequestInit & TransportObservation & TransportControl;

export function mergeTransportStates(a: TransportState, b: TransportState): TransportState {
  if (a === 'attempted' || b === 'attempted') return 'attempted';
  return a === 'unknown' || b === 'unknown' ? 'unknown' : 'not-attempted';
}

/** Observability must never change transport behavior, even for a faulty injected observer. */
export function observeTransport(
  options: TransportObservation | undefined,
  state: TransportState,
): boolean {
  try {
    const result: unknown = options?.onTransportState?.(state);
    // Async callbacks are assignable to void callbacks. Never await instrumentation or leak rejection.
    Promise.resolve(result).catch(() => undefined);
    return options?.onTransportState !== undefined;
  } catch {
    // No logger or further observer here: either could throw again or expose target credentials.
    return false;
  }
}

/** Explicit native adapter. Arbitrary injected fetch functions must NOT be wrapped as native. */
export function createObservedNativeFetch(): typeof fetch {
  return (input, init?: ObservedRequestInit) => {
    const { onTransportState, beforeTransport, ...requestInit } = init ?? {};
    beforeTransport?.();
    observeTransport({ onTransportState }, 'attempted');
    return globalThis.fetch(input, requestInit);
  };
}
