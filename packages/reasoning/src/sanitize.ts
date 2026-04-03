/**
 * @dino/reasoning — LLM input sanitization (Hard Constraint #22)
 *
 * Strips tenant secrets (API keys, tokens, auth headers) before data
 * reaches any LLM provider. SOC 2 CC6.1 / ISO 27001 A.13.1.1.
 *
 * Redaction contract: see docs/REDACTION_POLICY.md
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Extensible credential pattern for tenant-specific secrets */
export interface TenantPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

// ---------------------------------------------------------------------------
// Core patterns
// ---------------------------------------------------------------------------

/** Authorization header values — case-insensitive per RFC 7230 / 7235 */
const AUTH_HEADER_PATTERN =
  /(?:Authorization)\s*[:=]\s*["']?(?:Bearer|Basic|Token|Digest)\s+[A-Za-z0-9+/=.~_-]{10,}["']?/gi;

/** Common API key headers — already case-insensitive */
const API_KEY_HEADER_PATTERN =
  /(?:x-api-key|api-key|apikey|x-auth-token)\s*[:=]\s*["']?[A-Za-z0-9+/=.~_-]{10,}["']?/gi;

/** JWT tokens (three base64url segments separated by dots) */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g;

/** Long hex strings that look like tokens/secrets (40+ hex chars) */
const HEX_TOKEN_PATTERN = /\b[0-9a-fA-F]{40,}\b/g;

// ---------------------------------------------------------------------------
// Hex allowlist — key-anchored JSON exemptions
// ---------------------------------------------------------------------------

/**
 * JSON keys whose hex values are safe (hashes, not secrets).
 * Exhaustive list — only these two keys exist in @dino/reasoning:
 *   - cacheKey (engine.ts:57)
 *   - schemaFp (engine.ts:66)
 */
const SAFE_HEX_KEY_PATTERN = /"(?:cacheKey|schemaFp)"\s*:\s*"([0-9a-fA-F]{40,})"/g;

// ---------------------------------------------------------------------------
// Tenant pattern registry
// ---------------------------------------------------------------------------

const DEFAULT_TENANT_PATTERNS: ReadonlyArray<TenantPattern> = [
  {
    name: 'paystack-secret',
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_PAYSTACK]',
  },
  {
    name: 'paystack-public',
    pattern: /\bpk_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_PAYSTACK]',
  },
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED_ANTHROPIC_KEY]',
  },
  {
    name: 'mongodb-uri',
    pattern: /mongodb(?:\+srv)?:\/\/[^\s"']+/gi,
    replacement: '[REDACTED_MONGODB_URI]',
  },
  {
    name: 'redis-uri',
    pattern: /redis:\/\/[^\s"']+/gi,
    replacement: '[REDACTED_REDIS_URI]',
  },
];

// ---------------------------------------------------------------------------
// Sanitization entry point
// ---------------------------------------------------------------------------

/**
 * Sanitizes text destined for an LLM provider by replacing known secret patterns.
 *
 * Applied at the prompt builder output level — the last step before data
 * reaches the reasoning engine and provider.
 *
 * @param text  - Serialized prompt text (typically JSON.stringify output)
 * @param opts  - Optional extra tenant patterns to apply on top of defaults
 */
export function sanitizeLLMInput(text: string, opts?: { extraPatterns?: TenantPattern[] }): string {
  // #427: Nonce-based placeholder to prevent collision with literal input
  const nonce = randomBytes(4).toString('hex');

  // 1. Protect safe hex values (key-anchored) before HEX_TOKEN_PATTERN runs
  const safeHexValues: string[] = [];
  let protected_ = text.replaceAll(SAFE_HEX_KEY_PATTERN, (fullMatch, hexValue: string) => {
    const idx = safeHexValues.length;
    safeHexValues.push(hexValue);
    return fullMatch.replace(hexValue, `__SAFE_HEX_${nonce}_${idx}__`);
  });

  // 2. Core patterns (auth headers, API keys, JWTs, hex tokens)
  protected_ = protected_
    .replaceAll(AUTH_HEADER_PATTERN, (match) => {
      const colonIndex = match.indexOf(':');
      const equalsIndex = match.indexOf('=');
      const separatorIndex = colonIndex >= 0 ? colonIndex : equalsIndex;
      const prefix = match.slice(0, separatorIndex + 1);
      return `${prefix} [REDACTED]`;
    })
    .replaceAll(API_KEY_HEADER_PATTERN, (match) => {
      const colonIndex = match.indexOf(':');
      const equalsIndex = match.indexOf('=');
      const separatorIndex = colonIndex >= 0 ? colonIndex : equalsIndex;
      const prefix = match.slice(0, separatorIndex + 1);
      return `${prefix} [REDACTED]`;
    })
    .replaceAll(JWT_PATTERN, '[REDACTED_JWT]')
    .replaceAll(HEX_TOKEN_PATTERN, '[REDACTED_TOKEN]');

  // 3. Default tenant patterns
  for (const tp of DEFAULT_TENANT_PATTERNS) {
    protected_ = protected_.replaceAll(tp.pattern, tp.replacement);
  }

  // 4. Extra tenant patterns (caller-provided)
  if (opts?.extraPatterns) {
    for (const tp of opts.extraPatterns) {
      protected_ = protected_.replaceAll(tp.pattern, tp.replacement);
    }
  }

  // 5. Restore safe hex values
  for (let i = 0; i < safeHexValues.length; i++) {
    protected_ = protected_.replace(`__SAFE_HEX_${nonce}_${i}__`, safeHexValues.at(i)!);
  }

  return protected_;
}
