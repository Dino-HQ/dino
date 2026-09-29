// @internal — tested via runner.ts (dino runner register; extracted for max-lines compliance)
/** `dino runner register` inputs and the admin-route request body (Cleanup V2 task 4c: the pinned signer identity). */

const DEFAULT_REGISTER_ENDPOINT = 'https://api.usedino.dev';

export const REGISTER_USAGE =
  'Usage: dino runner register --token <admin-api-key> --name <name> --tenant <tenantId> [--endpoint <url>] [--attestation-identity <uri>]';

export interface RegisterFlags {
  token: string;
  name: string;
  tenantId: string;
  endpoint: string;
  /** The GitHub Actions workflow identity URI this runner signs attestations with (pins `dino verify`). */
  attestationIdentity?: string;
}

export function parseRegisterFlags(flags: Record<string, unknown>): RegisterFlags | null {
  const token = typeof flags.token === 'string' ? flags.token : '';
  const name = typeof flags.name === 'string' ? flags.name : '';
  const tenantId = typeof flags.tenant === 'string' ? flags.tenant : '';
  const endpoint =
    typeof flags.endpoint === 'string' && flags.endpoint.length > 0
      ? flags.endpoint.replace(/\/$/, '')
      : DEFAULT_REGISTER_ENDPOINT;

  if (!token || !name || !tenantId) return null;
  const attestationIdentity = flags.attestationIdentity; // parseArgs camel-cases `--attestation-identity`
  return typeof attestationIdentity === 'string' && attestationIdentity.length > 0
    ? { token, name, tenantId, endpoint, attestationIdentity }
    : { token, name, tenantId, endpoint };
}

/** Human-readable ` : <detail>` suffix from an already-read error body text. */
export function formatRegisterErrorDetail(text: string): string {
  if (!text) return '';
  try {
    const j = JSON.parse(text) as { error?: unknown };
    // A Dino error envelope nests `error: { message }`; a legacy body used a bare `error` string.
    if (j.error !== null && typeof j.error === 'object') {
      const message = (j.error as { message?: unknown }).message;
      return typeof message === 'string' && message.length > 0 ? `: ${message}` : '';
    }
    return typeof j.error === 'string' && j.error.length > 0 ? `: ${j.error}` : '';
  } catch {
    return `: ${text.slice(0, 200)}`;
  }
}

/** The admin register body: the identity is sent only when given (the cloud validates it as an https URI). */
export function registerRequestBody(parsed: RegisterFlags): { name: string; tenantId: string; attestationIdentity?: string } {
  return {
    name: parsed.name,
    tenantId: parsed.tenantId,
    ...(parsed.attestationIdentity === undefined ? {} : { attestationIdentity: parsed.attestationIdentity }),
  };
}
