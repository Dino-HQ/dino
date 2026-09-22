// packages/core/src/types/dino-result/drift.ts
/**
 * Scope drift (Cleanup V2 task 4a, closeout §7): the one cross-run comparison of two `DinoResult`s'
 * `operations[]` — identities added, removed, and signatures changed. Owned here (HC-37: no changelog
 * generator outside core/engine); the cloud only loads two parsed results and calls it. Scope
 * snapshot digests are identity markers: reported same/different per source, never diffed.
 */
import { byCodeUnit, canonicalDinoResultBytes } from './canonical';
import type { DinoResult } from './v1';

type Operation = DinoResult['operations'][number];
type Source = DinoResult['scope']['snapshots'][number]['source'];

export interface OperationIdentity {
  protocol: Operation['protocol'];
  operationKey: string;
}

/** A retained identity whose scope-significant signature differs between the two results. */
export interface ChangedOperation {
  identity: OperationIdentity;
  signature: 'changed';
}

export interface ScopeDrift {
  added: OperationIdentity[];
  removed: OperationIdentity[];
  changed: ChangedOperation[];
  /** Per source present in either result: whether both carry the same digest (absent on one side ⇒ false). */
  snapshots: { source: Source; same: boolean }[];
}

const identityKey = (op: OperationIdentity): string => `${op.protocol} ${op.operationKey}`;
const identityOf = (op: Operation): OperationIdentity => ({ protocol: op.protocol, operationKey: op.operationKey });

/**
 * Every scope-significant field a 1.0 row exposes (the task-3 identity projection): name, kind, module,
 * deprecation, description, GraphQL arguments and return type, REST parameters, body and responses.
 * Canonical bytes, so key order and `undefined` never matter.
 */
export function operationSignature(op: Operation): string {
  return canonicalDinoResultBytes({
    name: op.name,
    kind: op.kind,
    module: op.module,
    deprecated: op.deprecated,
    schemaDescription: op.schemaDescription,
    args: op.args,
    returnType: op.returnType,
    parameters: op.parameters,
    requestBody: op.requestBody,
    responseSchemas: op.responseSchemas,
  });
}

const sorted = (ops: OperationIdentity[]): OperationIdentity[] => [...ops].sort((a, b) => byCodeUnit(identityKey(a), identityKey(b)));

export function scopeDrift(baseline: DinoResult, current: DinoResult): ScopeDrift {
  const before = new Map(baseline.operations.map((op) => [identityKey(op), op]));
  const after = new Map(current.operations.map((op) => [identityKey(op), op]));
  const added = sorted([...after.values()].filter((op) => !before.has(identityKey(op))).map(identityOf));
  const removed = sorted([...before.values()].filter((op) => !after.has(identityKey(op))).map(identityOf));
  const changed = sorted(
    [...after.values()]
      .filter((op) => {
        const prior = before.get(identityKey(op));
        return prior !== undefined && operationSignature(prior) !== operationSignature(op);
      })
      .map(identityOf),
  ).map((identity): ChangedOperation => ({ identity, signature: 'changed' }));
  const digests = (r: DinoResult): Map<Source, string> => new Map(r.scope.snapshots.map((s) => [s.source, s.digest]));
  const b = digests(baseline);
  const c = digests(current);
  const sources = [...new Set([...b.keys(), ...c.keys()])].sort(byCodeUnit);
  const snapshots = sources.map((source) => ({ source, same: b.has(source) && c.has(source) && b.get(source) === c.get(source) }));
  return { added, removed, changed, snapshots };
}
