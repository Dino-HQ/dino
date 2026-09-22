// packages/core/src/types/dino-result/sanitize.ts
import { sanitizeErrorMessage } from '../../utils/error-sanitizer';

/**
 * Field-owned sanitisation (spec §8, review C‑14): evidence text is rewritten, identity fields are
 * validated and rejected. The same patterns feed the cloud's reject-mode detector in task 4a.
 */
export const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /Bearer\s+[\w/+=.-]+=*/gi,
  /(?:api[_-]?key|apikey|token|secret|password|authorization)\s*[:=]\s*["']?[\w/+=.-]{8,}["']?/gi,
  /(?:sk|pk)[-_](?:live|test)[-_][A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]);

/** Any authority userinfo, with or without a password — a bare username can be a key (review 5 C‑3). */
const URL_USERINFO = /\/\/[^/@\s]+@/g;
/** Credential-named query parameters: the whole value goes, whatever its length (review 3 C‑4). */
const SECRET_QUERY = /([?&](?:api[_-]?key|apikey|token|secret|password|authorization|auth|key)=)[^\s&"')\]]+/gi;
export const EVIDENCE_MAX_CHARS = 2048;
const TRUNCATED = '…[TRUNCATED]';

export class DinoResultSecretError extends Error {
  constructor(field: string) {
    super(`[dino-result] secret-shaped value in identity field ${field}`);
    this.name = 'DinoResultSecretError';
  }
}

function matchesSecret(value: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(value);
  });
}

/** Evidence text: examples, crash reasons, descriptions. Rewritten, then capped. */
export function sanitizeEvidenceText(value: string): string {
  // Percent-encoded evidence (a URL in an example or crash reason) is decoded first when the decoded form is
  // secret-bearing, so the shared policy sees the credential (Codex review); plain evidence is left as written.
  const decoded = safeDecode(value);
  let out = sanitizeErrorMessage(decoded !== value && matchesSecret(decoded) ? decoded : value);
  for (const pattern of SECRET_PATTERNS) out = out.replaceAll(pattern, '[REDACTED]');
  out = out.replaceAll(URL_USERINFO, '//[REDACTED]@');
  // The suffix lives inside the cap so a sanitised value always satisfies the schema's maxLength.
  return out.length > EVIDENCE_MAX_CHARS ? `${out.slice(0, EVIDENCE_MAX_CHARS - TRUNCATED.length)}${TRUNCATED}` : out;
}

const CREDENTIAL_NAME = /^(?:api[_-]?key|apikey|token|secret|password|authorization|auth|key)$/i;

/**
 * Percent-decoding that never throws and never gives up: each run of escapes is decoded on its own, so one
 * malformed sequence (`%ZZ`) cannot suppress the decoding of a valid credential elsewhere in the value (Codex review).
 */
function safeDecode(value: string): string {
  return value.replaceAll(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Target URLs keep their identity (host, path, parameter names) but never userinfo or a credential value:
 * a value goes when its name is credential-like OR the value itself is secret-shaped under any name
 * (review 6 C‑4). Parsed structurally; the regex path only serves a string `URL` cannot parse.
 */
export function sanitizeTargetUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable URL: names, values, and finally any secret-shaped run of text anywhere in it.
    // Not a parseable URL: same policy over the query-shaped text — credential names and secret-shaped values both go.
    return url.replaceAll(URL_USERINFO, '//').replaceAll(SECRET_QUERY, '$1[REDACTED]').replaceAll(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (m, sep: string, name: string, value: string) => {
      const nameSecret = matchesSecret(name) || matchesSecret(safeDecode(name));
      const valueSecret = matchesSecret(value) || matchesSecret(safeDecode(value));
      if (!nameSecret && !valueSecret) return m;
      return `${sep}${nameSecret ? '[REDACTED]' : name}=[REDACTED]`;
    }).replaceAll(/[^\s/?#&=]+/g, (part) => (matchesSecret(part) || matchesSecret(safeDecode(part)) ? '[REDACTED]' : part));
  }
  const userinfo = parsed.username !== '' || parsed.password !== '';
  let redacted = false;
  // A credential can be a hostname label too (Codex review): redact the label with a DNS-safe placeholder
  // (brackets belong to IPv6 literals in an authority), so the target stays a parseable URL.
  const hostname = parsed.hostname.split('.').map((label) => {
    if (!matchesSecret(label) && !matchesSecret(safeDecode(label))) return label;
    redacted = true;
    return 'redacted';
  }).join('.');
  const host = parsed.port === '' ? hostname : `${hostname}:${parsed.port}`;
  const params = [...parsed.searchParams.entries()].map(([name, value]) => {
    // A credential can be the parameter name itself (`?sk_live_…=x`); names arrive decoded from `searchParams`.
    const nameSecret = matchesSecret(name);
    if (!nameSecret && !CREDENTIAL_NAME.test(name) && !matchesSecret(value)) return [name, value] as const;
    redacted = true;
    return [nameSecret ? '[REDACTED]' : name, '[REDACTED]'] as const;
  });
  // A credential can sit in a path segment or the fragment too (a webhook URL): same policy, same marker.
  // Both stay percent-encoded on `URL`, so each is decoded before the test (Codex review).
  const pathname = parsed.pathname.split('/').map((segment) => {
    if (!matchesSecret(segment) && !matchesSecret(safeDecode(segment))) return segment;
    redacted = true;
    return '[REDACTED]';
  }).join('/');
  const hash = matchesSecret(parsed.hash) || matchesSecret(safeDecode(parsed.hash)) ? '#[REDACTED]' : parsed.hash;
  if (hash !== parsed.hash) redacted = true;
  if (!userinfo && !redacted) return url;
  const keep = (part: string): string => (part === '[REDACTED]' ? part : encodeURIComponent(part));
  const query = params.map(([name, value]) => `${keep(name)}=${keep(value)}`).join('&');
  const search = query === '' ? '' : `?${query}`;
  return `${parsed.protocol}//${host}${pathname}${search}${hash}`;
}

/** Identity keys, enums, module names, classifications, versions: validated (raw and percent-decoded), never rewritten. */
export function assertNoSecretShape(value: string, field: string): string {
  if (matchesSecret(value) || matchesSecret(safeDecode(value))) throw new DinoResultSecretError(field);
  return value;
}
