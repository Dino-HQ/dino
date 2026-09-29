/**
 * @dino/cli — decode a Dino cloud error body back into a DinoError.
 *
 * When the CLI calls Dino's own API (login/whoami, runner registration, …) a failure arrives as
 * `{ error: { code, message, status } }` — the same envelope `DinoError.toJSON()` emits. Rebuilding
 * the DinoError lets the caught-error classifier read the contract table for that code instead of
 * matching the message text. Only codes the table knows are accepted; anything else stays as-is.
 */

import { DinoError, ERROR_CONTRACT, EXIT_CODE, type DinoErrorCode } from '@dino/core';
import { CliError } from './errors';

function isKnownCode(code: string): code is DinoErrorCode {
  return Object.hasOwn(ERROR_CONTRACT, code);
}

type CloudStatusKind = 'usage' | 'config' | 'transient';

/** The outcome an HTTP failure from Dino's API stands for when its body carries no Dino code. */
export function cloudStatusKind(status: number): CloudStatusKind {
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  if (status === 401 || status === 402 || status === 403) return 'config';
  return 'usage';
}

/** A CliError for a Dino API HTTP failure whose body was not a Dino error envelope. */
export function cloudHttpFailure(message: string, status: number, hint?: string): CliError {
  const kind = cloudStatusKind(status);
  return new CliError(
    message,
    EXIT_CODE.get(kind) ?? 70,
    hint,
    undefined,
    kind,
    kind === 'transient' ? 'transient' : 'permanent',
  );
}

/**
 * Rebuild a DinoError from a parsed cloud error body, or null when the body is not a Dino error
 * envelope carrying a known code (malformed body, an unknown code, or a bare string error). The code
 * is trusted only when the response's HTTP status is the one the contract declares for it, so an
 * intermediary's look-alike body can't borrow a Dino code's meaning.
 */
export function dinoErrorFromCloudBody(body: unknown, httpStatus: number): DinoError | null {
  if (body === null || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !isKnownCode(code)) return null;
  if (ERROR_CONTRACT[code].status !== httpStatus) return null;
  const rawMessage = (error as { message?: unknown }).message;
  const message = typeof rawMessage === 'string' && rawMessage.length > 0 ? rawMessage : code;
  return new DinoError({ code, message });
}

/** Decode an already-read response body text (JSON) into a DinoError, or null. */
export function dinoErrorFromCloudBodyText(text: string, httpStatus: number): DinoError | null {
  if (text.length === 0) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null; // masked-fix:allowed - a non-JSON body isn't a Dino error envelope; caller keeps its fallback
  }
  return dinoErrorFromCloudBody(body, httpStatus);
}

/**
 * Read an HTTP error Response's JSON body and decode it. Returns null when the body is not JSON or
 * not a Dino error envelope with a known code, so the caller keeps its existing fallback.
 */
export async function decodeCloudErrorResponse(res: Response): Promise<DinoError | null> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null; // masked-fix:allowed - a non-JSON body isn't a Dino error envelope; caller keeps its fallback
  }
  return dinoErrorFromCloudBody(body, res.status);
}
