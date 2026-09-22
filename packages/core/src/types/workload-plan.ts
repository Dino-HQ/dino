import type { Operation } from './operation';
import type { NotTestedReason } from './result-envelope';
import type { TransportControl, TransportObservation } from '../tenant/transport-observation';

export type PlanUnitId = string;

export type HttpMethod = NonNullable<Operation['method']>;

/** Portable plan data; execution policy belongs to the engine. */
export type PlanUnit<TDescriptor> = Readonly<{
  id: PlanUnitId;
  operationKey: string;
  effect: 'read' | 'write';
  descriptor: Readonly<TDescriptor>;
}>;

export type Disposition =
  { kind: 'passed' } | { kind: 'failed' } | { kind: 'notTested'; reason: NotTestedReason };

export interface PlanUnitControl extends TransportControl, TransportObservation {
  planUnitId: PlanUnitId;
  deadline?: number | undefined;
  signal?: AbortSignal | undefined;
}

export type PlanUnitResult<Entry> =
  | Readonly<{ entry: Entry; backoffMs?: number | undefined }>
  | Readonly<{
      disposition: Extract<Disposition, { kind: 'notTested' }>;
      entry?: never;
      backoffMs?: never;
    }>;
