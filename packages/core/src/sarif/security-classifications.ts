import type { DinoToolName } from '../types/dino-result/v1-common';

/**
 * The classifications that are security weaknesses, as opposed to contract, error-handling, deprecation or
 * transport outcomes. Consumers that separate security from quality (SARIF `security` tag +
 * `security-severity`) read this one list; every entry must exist in the tool's severity table.
 */
export const SECURITY_CLASSIFICATIONS: Readonly<Record<DinoToolName, readonly string[]>> = Object.freeze({
  'input-fuzzer': ['DATA_LEAK'],
  'rest-fuzzer': ['DATA_LEAK', 'SUSPICIOUS_ACCEPT', 'CORS_MISCONFIGURATION', 'HOST_REFLECTED'],
  'rbac-matrix': ['RBAC_BYPASS', 'RBAC_ROLE_BYPASS', 'RBAC_UNAUTH_ACCESS', 'RBAC_UNAUTH_ACCESS_PROBE', 'CRITICAL', 'HIGH', 'MEDIUM'],
  'error-code-validator': ['LEAK'],
  'response-validator': ['NO_WRITEONLY_EXPOSED_FAIL'],
  'rate-limit-validator': ['NOT_DETECTED', 'ALLOWED'],
  'deprecation-tracker': [],
});

export function isSecurityClassification(tool: DinoToolName, classification: string): boolean {
  return SECURITY_CLASSIFICATIONS[tool].includes(classification);
}
