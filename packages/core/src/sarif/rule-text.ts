import type { DinoToolName } from '../types/dino-result/v1-common';

/** What a code-scanning rule shows: a title, what Dino observed, and what to do about it. */
export interface SarifRuleText {
  short: string;
  full: string;
  help: string;
}

const t = (short: string, full: string, help: string): SarifRuleText => ({
  short,
  full,
  help,
});

const NOT_TESTED_HELP =
  'This operation was not tested in this run, so it is a coverage gap, not a pass. Check that the target is reachable from where Dino runs and re-run the scan.';

const TRANSPORT = {
  TRANSPORT_TIMEOUT: t(
    'Request timed out',
    'Dino sent a request and the target did not answer before the request timeout.',
    NOT_TESTED_HELP,
  ),
  TRANSPORT_UNREACHABLE: t(
    'Target unreachable',
    'Dino could not reach the target for this request (DNS, connection refused or TLS failure).',
    NOT_TESTED_HELP,
  ),
  TRANSPORT_ABORTED: t(
    'Request aborted',
    'The request was cancelled before the target answered, for example because the run hit its time budget.',
    NOT_TESTED_HELP,
  ),
  TRANSPORT_UNKNOWN: t(
    'No usable response',
    'The request ended without a usable HTTP status, so Dino could not judge the result.',
    NOT_TESTED_HELP,
  ),
  TARGET_BLOCKED: t(
    'Request blocked before sending',
    "Dino's network safety checks refused to send this request to the target address.",
    'This operation was not tested. If the target is yours and intended (for example a private address), allow it explicitly and re-run.',
  ),
} satisfies Record<string, SarifRuleText>;

export const SARIF_RULE_TEXT: Readonly<Record<DinoToolName, Readonly<Record<string, SarifRuleText>>>> = Object.freeze({
  'input-fuzzer': {
    DATA_LEAK: t(
      'Error response leaks internal details',
      'A malformed GraphQL input produced an error message that exposes internal details such as a stack trace, a database error or a file path.',
      'Return generic error messages to clients and log the details server-side only.',
    ),
    SILENT_FAILURE: t(
      'Malformed input neither rejected nor accepted',
      'A malformed GraphQL input got a response with no error and no success status, so the client cannot tell what happened.',
      'Validate the input and answer with a clear validation error.',
    ),
    SERVER_ERROR: t(
      'Malformed input caused a server error',
      'A malformed GraphQL input made the server answer with a 5xx status instead of a validation error.',
      'Validate the input before it reaches your resolvers and answer with a client error.',
    ),
    VALIDATION_ERROR: t(
      'Input rejected with an error',
      'The API answered a malformed input with a GraphQL error.',
      'No action needed; this is the expected behaviour.',
    ),
    VALIDATION_CORRECT: t(
      'Input correctly rejected',
      'The API rejected a malformed input with an error and a client-error status.',
      'No action needed.',
    ),
    ACCEPTED: t(
      'Input accepted',
      'The API answered a fuzzed input with a success status and no error.',
      'Check that the accepted value is really valid for this field.',
    ),
    HTTP_CLIENT_ERROR: t(
      'Input rejected with a client error',
      'The API answered a malformed input with a 4xx status and no GraphQL error.',
      'No action needed; consider returning a GraphQL error that says what was wrong.',
    ),
    MALFORMED_RESPONSE: t(
      'Response could not be parsed',
      'The API answered with a body Dino could not parse as a GraphQL response.',
      'Make sure every response is valid GraphQL JSON, including error responses.',
    ),
    ...TRANSPORT,
  },
  'rest-fuzzer': {
    DATA_LEAK: t(
      'Error response leaks internal details',
      'A fuzzed REST request produced a response that exposes internal details such as a stack trace, a database error or a file path.',
      'Return generic error messages to clients and log the details server-side only.',
    ),
    SUSPICIOUS_ACCEPT: t(
      'Malicious input accepted',
      'The API answered a fuzzed request carrying an invalid or malicious value with a 2xx success.',
      'Validate request parameters and bodies against the documented types and reject invalid values with a 4xx.',
    ),
    CORS_MISCONFIGURATION: t(
      'CORS allows an arbitrary origin',
      'The API echoed an untrusted Origin back in Access-Control-Allow-Origin, so any website could read its responses in a browser.',
      'Allow only known origins, and never reflect the request Origin with credentials enabled.',
    ),
    HOST_REFLECTED: t(
      'Host header reflected',
      'A Host header value injected by Dino came back in the response body or a redirect Location, which enables host-header injection and cache poisoning.',
      'Build absolute URLs from configuration, not from the incoming Host header.',
    ),
    SERVER_ERROR: t(
      'Fuzzed request caused a server error',
      'A fuzzed REST request made the server answer with a 5xx status instead of a client error.',
      'Validate input before it reaches your handlers and answer with a 4xx.',
    ),
    CORRECT_REJECTION: t(
      'Input correctly rejected',
      'The API rejected an invalid request with a client-error status.',
      'No action needed.',
    ),
    AUTH_REJECTED: t(
      'Request rejected by authentication',
      'The API rejected the fuzzed request as unauthenticated.',
      'No action needed; to fuzz deeper, give Dino credentials for this API.',
    ),
    METHOD_CORRECTLY_REJECTED: t(
      'Unsupported method correctly rejected',
      'The API rejected an unsupported HTTP method.',
      'No action needed.',
    ),
    PAYLOAD_TOO_LARGE: t(
      'Oversized payload correctly rejected',
      'The API rejected an oversized request body with 413.',
      'No action needed.',
    ),
    RATE_LIMITED: t('Request rate-limited', 'The API rate-limited the fuzzed request.', 'No action needed.'),
    NETWORK_ERROR: t('Network error', 'The request failed at the network level before a response arrived.', NOT_TESTED_HELP),
    INCONCLUSIVE: t(
      'Inconclusive response',
      'The response did not show clearly whether the input was handled correctly.',
      'Review the operation manually or re-run with a more specific OpenAPI spec.',
    ),
    EXECUTION_ERROR: t(
      'Dino could not execute the request',
      'Dino could not build or send this request from the OpenAPI spec.',
      'This operation was not tested. Check that the spec describes its parameters and request body.',
    ),
    TRANSPORT_TIMEOUT: TRANSPORT.TRANSPORT_TIMEOUT,
    TRANSPORT_ABORTED: TRANSPORT.TRANSPORT_ABORTED,
    TRANSPORT_UNKNOWN: TRANSPORT.TRANSPORT_UNKNOWN,
  },
  'response-validator': {
    SCHEMA_MISMATCH: t(
      'Response does not match the schema',
      "A GraphQL response's shape or types differ from what the schema declares.",
      'Fix the resolver or update the schema so both describe the same data.',
    ),
    EXTRA_FIELDS: t(
      'Response has fields the schema lacks',
      'A GraphQL response contained fields that are not in the schema.',
      'Remove the fields or add them to the schema.',
    ),
    EXECUTION_ERROR: t(
      'Query returned execution errors',
      'A valid query returned GraphQL execution errors.',
      'Check the resolver for this field; a valid query should not fail.',
    ),
    INTROSPECTION_FAILURE: t(
      'Introspection failed',
      'Dino could not introspect the schema, so responses could only be checked partly.',
      'Enable introspection for Dino, or give it the schema as an SDL file.',
    ),
    INTROSPECTION_SKIPPED: t(
      'Introspection skipped',
      'Introspection was not attempted for this run.',
      'No action needed unless you expected schema checks.',
    ),
    VALID: t('Response matches the schema', 'The response matched the declared schema.', 'No action needed.'),
    STATUS_DOCUMENTED_FAIL: t(
      'Status code not documented',
      'The API answered with a status code the OpenAPI spec does not document for this operation.',
      'Document the status in the spec, or change the API to return a documented one.',
    ),
    CONTENT_TYPE_MATCH_FAIL: t(
      'Content type differs from the spec',
      'The response Content-Type differs from the media types the spec declares.',
      'Return the documented content type, or update the spec.',
    ),
    REQUIRED_FIELDS_PRESENT_FAIL: t(
      'Required field missing',
      'The response lacks a field the spec marks as required.',
      'Return every required field, or mark it optional in the spec.',
    ),
    NO_EXTRA_FIELDS_FAIL: t(
      'Undocumented field in response',
      'The response contains a field the spec does not declare.',
      'Remove the field or add it to the spec.',
    ),
    NO_WRITEONLY_EXPOSED_FAIL: t(
      'Write-only field exposed',
      'The response contains a field the spec marks writeOnly, such as a password or secret.',
      'Never return write-only fields; remove them from the response serializer.',
    ),
    BODY_TYPE_MATCH_FAIL: t(
      'Response body type differs from the spec',
      'A value in the response has a different type from the one the spec declares.',
      'Return the documented type, or correct the spec.',
    ),
    SPEC_UNVERIFIABLE: t(
      'Spec could not be checked',
      'The spec did not describe this response well enough for Dino to check it.',
      'Add a response schema for this operation to the OpenAPI spec.',
    ),
    ...TRANSPORT,
  },
  'rbac-matrix': {
    RBAC_BYPASS: t(
      'Unauthenticated access to a protected operation',
      'An unauthenticated request succeeded on an operation that should deny it.',
      'Enforce authentication on this operation before any business logic runs.',
    ),
    RBAC_ROLE_BYPASS: t(
      'Role can access an operation it should not',
      'A signed-in role succeeded on an operation that should deny that role.',
      'Check the role permission on this operation in your authorization layer.',
    ),
    RBAC_UNAUTH_ACCESS: t(
      'Operation reachable without authentication',
      'An unauthenticated request succeeded on an operation with no declared access rule.',
      'If the operation is meant to be public, declare it; otherwise require authentication.',
    ),
    RBAC_UNAUTH_ACCESS_PROBE: t(
      'Operation may be reachable without authentication',
      'An unauthenticated probe got a non-denied response on an operation with no declared access rule.',
      'Declare the expected access for this operation so Dino can verify it, and require authentication if it is not public.',
    ),
    CRITICAL: t(
      'Critical access-control violation',
      'An access-control check failed with critical severity.',
      'Review the authorization rule for this operation.',
    ),
    HIGH: t(
      'High-severity access-control violation',
      'An access-control check failed with high severity.',
      'Review the authorization rule for this operation.',
    ),
    MEDIUM: t(
      'Access-control violation',
      'An access-control check failed with medium severity.',
      'Review the authorization rule for this operation.',
    ),
    RBAC_BLOCKED: t(
      'Allowed role was denied',
      'A role that should be allowed was denied access. This is a functional failure, not a security weakness.',
      'Check the role permission; legitimate users are being blocked.',
    ),
    RBAC_INCONCLUSIVE: t(
      'Access check inconclusive',
      'The response did not show whether access was granted, for example because the request never reached the authorization layer.',
      'Give Dino valid inputs or credentials for this operation and re-run.',
    ),
    RBAC_PASS: t('Access rule holds', 'The operation granted and denied access as declared.', 'No action needed.'),
    ...TRANSPORT,
  },
  'rate-limit-validator': {
    NOT_DETECTED: t(
      'No rate limiting detected',
      'A burst of requests was all served with no rate limiting and no rate-limit headers.',
      'Add rate limiting to this operation (OWASP API4: unrestricted resource consumption).',
    ),
    ALLOWED: t(
      'Request not rate-limited',
      'A request in the burst was served with no rate limiting.',
      'Add rate limiting to this operation.',
    ),
    HEADERS_ONLY: t(
      'Rate-limit headers without enforcement',
      'The API sent rate-limit headers but did not throttle the burst.',
      'Enforce the limit the headers advertise.',
    ),
    SERVER_ERROR: t(
      'Burst caused server errors',
      'Most requests in a burst failed with a 5xx status instead of being rate-limited.',
      'Add rate limiting so load is rejected with 429 before it overwhelms the service.',
    ),
    AUTH_ERROR: t(
      'Burst rejected by authentication',
      'Every request in the burst was rejected as unauthenticated, so rate limiting could not be tested.',
      'Give Dino credentials for this API and re-run.',
    ),
    TIMEOUT: t(
      'Burst timed out',
      'Requests in the burst timed out instead of being rate-limited.',
      'Add rate limiting so excess load is rejected quickly with 429.',
    ),
    RATE_LIMITED: t('Rate limit enforced', 'The API rate-limited the burst.', 'No action needed.'),
    TRANSPORT_UNKNOWN: TRANSPORT.TRANSPORT_UNKNOWN,
  },
  'error-code-validator': {
    LEAK: t(
      'Error message leaks internal details',
      'An error response exposes internal details such as a stack trace, a query or a driver message.',
      'Return generic error messages to clients and log the details server-side only.',
    ),
    INCONSISTENT: t(
      'Inconsistent error code',
      "The error code returned for a failure scenario doesn't match the one expected for it.",
      'Use one error code per failure type across operations.',
    ),
    CONSISTENT: t('Error code consistent', 'The error code matched the expected pattern.', 'No action needed.'),
    NO_ERROR: t(
      'Expected error not returned',
      'A request that should fail returned no error, which may mean missing validation.',
      'Validate the input and return an error for this scenario.',
    ),
    INCONCLUSIVE: t(
      'Error check inconclusive',
      'The response did not show clearly whether the error handling was correct.',
      'Review the operation manually.',
    ),
    ...TRANSPORT,
  },
  'deprecation-tracker': {
    NOT_DEPRECATED: t('Not deprecated', 'The operation is not deprecated.', 'No action needed.'),
    DEPRECATED_IN_REGISTRY: t(
      'Deprecated operation still in use',
      'A deprecated operation is still listed in your operation registry, so your clients still call it.',
      'Move clients off this operation before removing it.',
    ),
    DEPRECATED_NOT_IN_REGISTRY: t(
      'Deprecated and unused',
      'A deprecated operation is not in your operation registry.',
      'It may be safe to remove after confirming no other clients call it.',
    ),
    SPEC_AND_HEADERS: t(
      'Deprecation declared and signalled',
      'The spec marks the operation deprecated and responses send deprecation headers.',
      'No action needed; plan the removal.',
    ),
    SPEC_ONLY: t(
      'Deprecation not signalled to clients',
      'The spec marks the operation deprecated, but responses send no Deprecation or Sunset header, so clients are not warned.',
      'Send Deprecation and Sunset headers on responses from this operation.',
    ),
    HEADERS_ONLY: t(
      'Deprecation headers without a spec entry',
      'Responses send deprecation headers, but the spec does not mark the operation deprecated.',
      'Mark the operation deprecated in the spec so docs and tools agree.',
    ),
    PROBE_INCONCLUSIVE: t(
      'Deprecation probe inconclusive',
      'Dino could not read deprecation headers from the response.',
      'Re-run with a request that reaches this operation.',
    ),
    ...TRANSPORT,
  },
});

/** Text for a classification outside every severity table: fixed, so rule metadata never depends on a run. */
export function sarifRuleText(tool: DinoToolName, classification: string): SarifRuleText {
  return (
    SARIF_RULE_TEXT[tool][classification] ??
    t(classification, `Dino's ${tool} reported ${classification}.`, 'See the Dino JSON or Markdown report for this run for details.')
  );
}
