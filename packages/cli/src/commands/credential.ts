/**
 * DIN-1493 — `dino credential set`: put one Target credential into Dino custody for an auth profile, through the
 * same credential handoff the hosted page uses. The secret is typed at a no-echo prompt (or piped with an explicit
 * `--stdin`); it is never accepted as a flag or argument, never printed, and goes only to the handoff submission.
 * The output is the Credential Reference and what to do next; storing it authorizes nothing.
 */

import { randomUUID } from 'node:crypto';
import { getValidToken } from '../auth/token-store';
import { cloudHttpFailure, decodeCloudErrorResponse } from '../shared/cloud-error';
import { CliError } from '../shared/errors';
import { promptHidden } from '../shared/hidden-prompt';

export const CREDENTIAL_USAGE = 'dino credential set --auth-profile <id> [--stdin]';

/** Flags that would put a secret on the command line (shell history, process lists); always refused. */
const SECRET_FLAGS = ['credential', 'secret', 'password', 'token', 'value', 'apiKey', 'key'];
const RETRY_DELAY_MS = 2000;

export interface CredentialDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly env: Record<string, string | undefined>;
  readonly token: () => Promise<string | null>;
  readonly readHidden: (question: string) => Promise<string>;
  readonly readStdin: () => Promise<string>;
  readonly stdinIsTty: boolean;
  readonly print: (line: string) => void;
  readonly newKey: () => string;
  readonly sleep: (ms: number) => Promise<void>;
}

type Opened = { handoff: { handoffId: string }; link: { url: string } };
type Stored = { credentialReferenceId: string; version: number; statement: string };

function usage(message: string): CliError {
  return new CliError(message, 2, `Usage: ${CREDENTIAL_USAGE}`, undefined, 'usage');
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function defaultDeps(): CredentialDeps {
  const env = { ...process.env };
  return {
    fetch,
    env,
    token: () => getValidToken({ now: () => Date.now(), http: fetch, env }), // determinism:allowed
    readHidden: (question) => promptHidden(question),
    readStdin: () => readAll(process.stdin),
    stdinIsTty: process.stdin.isTTY === true,
    print: (line) => console.info(line),
    newKey: () => randomUUID(), // determinism:allowed - production idempotency key; tests inject newKey
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), // determinism:allowed - production delay; tests inject sleep
  };
}

/** Refuse anything that would carry the secret on the command line, before any network call. */
function parseInvocation(argv: string[], flags: Record<string, unknown>) {
  if (argv.at(1) !== 'set') throw usage('Unknown or missing subcommand');
  const positional = Object.keys(flags).filter((k) => /^_\d+$/.test(k) && flags[k] !== 'set');
  const secretFlag = SECRET_FLAGS.find((k) => flags[k] !== undefined);
  if (positional.length > 0 || secretFlag !== undefined) {
    throw usage('The secret is never accepted as an argument or flag: type it at the prompt, or pipe it with --stdin');
  }
  const authProfileId = flags.authProfile;
  if (typeof authProfileId !== 'string' || authProfileId === '') throw usage('--auth-profile <id> is required');
  const apiUrl = typeof flags.apiUrl === 'string' && flags.apiUrl !== '' ? flags.apiUrl : undefined;
  return { authProfileId, stdin: flags.stdin === true, apiUrl };
}

async function request(
  deps: CredentialDeps,
  call: { url: string; token: string; method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${call.token}`, Accept: 'application/json' };
  if (call.body !== undefined) headers['Content-Type'] = 'application/json';
  if (call.idempotencyKey !== undefined) headers['Idempotency-Key'] = call.idempotencyKey;
  try {
    return await deps.fetch(call.url, {
      method: call.method,
      headers,
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });
  } catch (error_) {
    // biome-ignore lint/style/useErrorCause: cause forwarded via CliError's 4th arg (biome only detects native Error 2nd-arg cause)
    throw new CliError('Failed to reach Dino API', 4, `Check ${new URL(call.url).origin}`, error_, 'transient', 'transient');
  }
}

async function expectOk<T>(res: Response, what: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const decoded = await decodeCloudErrorResponse(res);
  if (decoded !== null) throw decoded;
  throw cloudHttpFailure(`${what} failed (HTTP ${res.status})`, res.status);
}

async function readSecret(deps: CredentialDeps, stdin: boolean): Promise<string> {
  if (stdin) return (await deps.readStdin()).replace(/\r?\n$/, '');
  if (!deps.stdinIsTty) {
    throw usage('No terminal to type the secret into: pipe it with --stdin, or run in an interactive terminal');
  }
  return deps.readHidden('Credential (input hidden): ');
}

/** Submit once, and once more with the SAME key if the custody outcome was unknown (never a second version). */
async function submit(
  deps: CredentialDeps,
  call: { url: string; token: string; body: { link: string; credential: string } },
): Promise<Response> {
  const idempotencyKey = deps.newKey();
  const first = await request(deps, { ...call, method: 'POST', idempotencyKey });
  if (first.status !== 503) return first;
  await deps.sleep(RETRY_DELAY_MS);
  return request(deps, { ...call, method: 'POST', idempotencyKey });
}

export async function runCredentialFromArgv(
  argv: string[],
  flags: Record<string, unknown>,
  deps: CredentialDeps = defaultDeps(),
): Promise<number> {
  const inv = parseInvocation(argv, flags);
  const token = await deps.token();
  if (token === null) {
    deps.print('Not logged in. Run `dino login`.');
    return 1;
  }
  const base = (inv.apiUrl ?? deps.env.DINO_API_URL?.trim() ?? 'https://api.usedino.dev').replace(/\/$/, '');
  const me = await expectOk<{ tenantId: string }>(await request(deps, { url: `${base}/v1/me`, token, method: 'GET' }), 'whoami');
  const opened = await expectOk<Opened>(
    await request(deps, {
      url: `${base}/v1/tenants/${encodeURIComponent(me.tenantId)}/credential-handoffs`,
      token,
      method: 'POST',
      body: { authProfileId: inv.authProfileId },
    }),
    'Opening the credential handoff',
  );
  const link = new URL(opened.link.url);
  const tenant = link.searchParams.get('tenant') ?? me.tenantId;
  const secret = await readSecret(deps, inv.stdin);
  if (secret === '') throw usage('No credential entered');
  const res = await submit(deps, {
    url: `${base}/v1/tenants/${encodeURIComponent(tenant)}/credential-handoffs/${encodeURIComponent(opened.handoff.handoffId)}/submissions`,
    token,
    body: { link: link.hash.slice(1), credential: secret },
  });
  const stored = await expectOk<Stored>(res, 'Storing the credential');
  deps.print(`Stored in Dino custody: Credential Reference ${stored.credentialReferenceId} (version ${stored.version}).`);
  deps.print(stored.statement);
  return 0;
}
