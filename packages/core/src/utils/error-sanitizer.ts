/**
 * @dino/core — Error message sanitizer (canonical implementation)
 *
 * Strip potential credentials from API error messages before storing in tool
 * results or analytics. Handles API keys, JWTs, Bearer tokens, URL credentials,
 * and query params that commonly contain secrets.
 * Re-exported by @dino/agents for backwards compatibility.
 *
 * ReDoS prevention (CWE-1333):
 * - Input capped at MAX_SANITIZE_LENGTH before any regex (bounds worst-case)
 * - Bearer tokens use string ops (indexOf + slice), not regex
 * - Remaining regex patterns use unambiguous character classes, no nested quantifiers
 */

/** Max input length before regex matching. Bounds worst-case backtracking to <1ms. */
const MAX_SANITIZE_LENGTH = 8192;

/**
 * Strip Bearer tokens using deterministic string operations (no regex).
 * Handles case-insensitive "Bearer " prefix, replaces the token value.
 */
function redactBearerTokens(input: string): string {
  let result = input;
  let searchFrom = 0;

  while (searchFrom < result.length) {
    const lower = result.toLowerCase();
    const idx = lower.indexOf('bearer ', searchFrom);
    if (idx === -1) break;

    const tokenStart = idx + 7; // length of "bearer "
    // Skip whitespace after "Bearer"
    let pos = tokenStart;
    while (pos < result.length && result.charAt(pos) === ' ') pos++;
    if (pos >= result.length) break;

    // Consume token characters (base64 + common token chars)
    const tokenBegin = pos;
    while (pos < result.length && /[-+/=.~_A-Za-z0-9]/.test(result.charAt(pos))) pos++;

    if (pos > tokenBegin) {
      result = result.slice(0, tokenBegin) + '[REDACTED]' + result.slice(pos);
      searchFrom = tokenBegin + 10; // length of "[REDACTED]"
    } else {
      searchFrom = pos + 1;
    }
  }

  return result;
}

/**
 * Strip potential credentials from API error messages before storing in tool results.
 * Handles: API keys, JWTs, Bearer tokens, connection strings with passwords.
 */
export function sanitizeErrorMessage(message: string): string {
  if (typeof message !== 'string') {
    return String(message ?? '');
  }
  if (!message) return message;

  // Layer 1: Cap input length to bound worst-case regex backtracking (CWE-1333)
  let sanitized =
    message.length > MAX_SANITIZE_LENGTH
      ? message.slice(0, MAX_SANITIZE_LENGTH) + '…[truncated]'
      : message;

  // Layer 2: Strip API keys (sk-ant-*, sk-*, key-*)
  // Safe: no nested quantifiers, unambiguous character class, bounded {10,200}
  sanitized = sanitized.replaceAll(
    /\b(sk-ant-[-a-zA-Z0-9_]{10,200}|sk-[-a-zA-Z0-9_]{20,200}|key-[-a-zA-Z0-9_]{10,200})\b/g,
    '[REDACTED_KEY]',
  );

  // Layer 3: Strip JWTs (eyJ...)
  // Safe: three unambiguous segments separated by literal dots, bounded {10,200}
  sanitized = sanitized.replaceAll(
    /\beyJ[A-Za-z0-9_-]{10,200}\.[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{1,200}\b/g,
    '[REDACTED_JWT]',
  );

  // Layer 4: Strip Bearer tokens using string operations (zero ReDoS risk)
  sanitized = redactBearerTokens(sanitized);

  // Layer 5: Strip URL credentials (user:pass@host)
  // Safe: negated class [^@\s] cannot overlap, bounded {1,200}
  sanitized = sanitized.replaceAll(/\/\/[^@\s]{1,200}@/g, '//[REDACTED]@');

  // Layer 6: Strip query params with secret names (?apiKey=..., ?token=..., etc.)
  // Safe: distinct prefixes in alternation, negated class [^\s&] cannot overlap, bounded {1,200}
  sanitized = sanitized.replaceAll(
    /[?&](apiKey|token|secret|key|password|auth)=[^\s&"')\]]{1,200}/gi,
    (match) => match.replace(/=[^\s&"')\]]{1,200}$/, '=[REDACTED]'),
  );

  return sanitized;
}
