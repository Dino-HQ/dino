/**
 * @dino/core — Error message sanitizer (canonical implementation)
 *
 * Strip potential credentials from API error messages before storing in tool
 * results or analytics. Handles API keys, JWTs, Bearer tokens, URL credentials,
 * and query params that commonly contain secrets.
 * Re-exported by @dino/agents for backwards compatibility.
 */

/**
 * Strip potential credentials from API error messages before storing in tool results.
 * Handles: API keys, JWTs, Bearer tokens, connection strings with passwords.
 */
export function sanitizeErrorMessage(message: string): string {
  if (typeof message !== 'string') {
    return String(message ?? '');
  }
  if (!message) return message;

  let sanitized = message;

  // Strip API keys (sk-ant-*, sk-*, key-*, etc.)
  sanitized = sanitized.replaceAll(
    /\b(sk-ant-[-a-zA-Z0-9_]{10,500}|sk-[-a-zA-Z0-9_]{20,500}|key-[-a-zA-Z0-9_]{10,500})\b/g,
    '[REDACTED_KEY]',
  );

  // Strip JWTs (eyJ...)
  sanitized = sanitized.replaceAll(
    /\beyJ[-a-zA-Z0-9_]{10,500}\.[-a-zA-Z0-9_]{1,500}\.[-a-zA-Z0-9_]{1,500}\b/g,
    '[REDACTED_JWT]',
  );

  // Strip Bearer tokens from error context (base64 chars +/= included).
  // S5869: hyphen is literal at start; \x2F \x2E prevent accidental ranges. NOSONAR: no actual duplicate.
  sanitized = sanitized.replaceAll(
    /Bearer\s{1,10}[-+\x2F=\x2E~_A-Za-z0-9]{1,2000}/gi,
    'Bearer [REDACTED]',
  ); // NOSONAR S5869 — no duplicate chars; hyphen is literal

  // Strip URL credentials (user:pass@host) — bounded to 200 chars to prevent backtracking
  sanitized = sanitized.replaceAll(/\/\/[^@\s]{1,200}@/g, '//[REDACTED]@');

  // Strip query params that commonly contain secrets (?apiKey=..., ?token=..., etc.)
  // Bounded to 500 chars; inner replace uses non-greedy match
  sanitized = sanitized.replaceAll(
    /[?&](apiKey|token|secret|key|password|auth)=[^\s&"')\]]{1,500}/gi,
    (match) => match.replace(/=.{1,500}$/, '=[REDACTED]'),
  );

  return sanitized;
}
