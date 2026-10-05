/**
 * DIN-1503/1504/1505/1506 — why a scan attempt could not run or failed. Every recorded failure is a stable code with
 * a bounded NextAction from the closed union in credential-next-action.ts; a NextAction grants no authority.
 */

import { credentialOutcomeError, isCredentialOutcomeCode } from './credential-outcome';
import { parseCredentialNextAction, type CredentialNextAction } from './credential-next-action';
import { ERROR_CONTRACT } from './error-contract';
import { DinoError, type DinoErrorCode } from './errors';
import { isTargetConnectionOutcomeCode, targetConnectionOutcomeError } from './target-connection-outcome';

export type ScanOutcomeCode = Extract<
  DinoErrorCode,
  | 'SCAN_API_SPEC_REQUIRED'
  | 'SCAN_API_SPEC_UNAVAILABLE'
  | 'SCAN_DISCOVERY_FAILED'
  | 'SCAN_RUNNER_UNAVAILABLE'
  | 'SCAN_RUNNER_FAILED'
>;

const OUTCOMES: { readonly [C in ScanOutcomeCode]: { message: string; nextAction: CredentialNextAction } } = {
  SCAN_API_SPEC_REQUIRED: {
    message: 'This REST API has no OpenAPI spec; attach one to the API before scanning it',
    nextAction: { kind: 'provide_input', reasonCode: 'scan_api_spec_required' },
  },
  SCAN_API_SPEC_UNAVAILABLE: {
    message: "The API's OpenAPI spec could not be fetched",
    nextAction: { kind: 'retry', reasonCode: 'scan_api_spec_unavailable' },
  },
  SCAN_DISCOVERY_FAILED: {
    message: 'Discovery found no operations to test on the Target',
    nextAction: { kind: 'provide_input', reasonCode: 'scan_discovery_failed' },
  },
  SCAN_RUNNER_UNAVAILABLE: {
    message: 'No registered runner for this Organization is online; start one to run the scan',
    nextAction: { kind: 'provide_input', reasonCode: 'scan_runner_unavailable' },
  },
  SCAN_RUNNER_FAILED: {
    message: 'The runner failed while executing the scan',
    nextAction: { kind: 'retry', reasonCode: 'scan_runner_failed' },
  },
};

/** Runner failure values that predate typed codes; the cloud still branches on `auth_lost`. */
const LEGACY_RUNNER_FAILURES: ReadonlySet<string> = new Set(['auth_failed', 'auth_lost']);

/**
 * DIN-1506: a recorded failure is a closed code — a registered DinoErrorCode or a legacy runner value. Anything else
 * (a newer runner's code, free text) is never stored; it becomes SCAN_RUNNER_FAILED and the text stays in the redacted
 * detail. Undefined when the runner named nothing.
 */
export function admittedFailureCode(reported: string | undefined): string | undefined {
  if (reported === undefined) return undefined;
  return Object.hasOwn(ERROR_CONTRACT, reported) || LEGACY_RUNNER_FAILURES.has(reported) ? reported : 'SCAN_RUNNER_FAILED';
}

export function isScanOutcomeCode(code: string): code is ScanOutcomeCode {
  return Object.hasOwn(OUTCOMES, code);
}

/** Build the typed error for a scan outcome, with an optional safe detail appended to the message. */
export function scanOutcomeError(code: ScanOutcomeCode, detail?: string, cause?: unknown): DinoError {
  const o = OUTCOMES[code];
  return new DinoError({
    code,
    message: detail === undefined ? o.message : `${o.message}: ${detail}`,
    meta: { nextAction: { ...o.nextAction } },
    ...(cause === undefined ? {} : { cause }),
  });
}

function nextActionOf(error: DinoError): CredentialNextAction | undefined {
  return parseCredentialNextAction(error.meta?.nextAction);
}

/**
 * The NextAction for a recorded attempt failure. `reported` is the NextAction the refusing decision returned (the
 * runner forwards it); it wins when valid, because some reasons (e.g. which status a Connection is in) are known only
 * at the decision. Otherwise the code's own NextAction; undefined for a code with none.
 */
export function scanFailureNextAction(failureType: string | null, reported?: unknown): CredentialNextAction | undefined {
  const fromDecision = parseCredentialNextAction(reported);
  if (fromDecision !== undefined) return fromDecision;
  if (failureType === null) return undefined;
  if (isScanOutcomeCode(failureType)) return { ...OUTCOMES[failureType].nextAction };
  if (isCredentialOutcomeCode(failureType)) return nextActionOf(credentialOutcomeError(failureType));
  if (isTargetConnectionOutcomeCode(failureType) && failureType !== 'TARGET_CONNECTION_NOT_AUTHORIZED') {
    return nextActionOf(targetConnectionOutcomeError(failureType));
  }
  return undefined;
}
