import {
  checkEndpointUrl,
  isLoopbackHostname,
  resolveVerificationTarget,
  type VerificationTarget,
  type VerificationTargetConfig,
} from "@dino/core";
import { CliError } from "./errors";

/**
 * Resolve one target, reporting a refused destination as the user's input rather than our crash.
 *
 * `resolveVerificationTarget` validates through a Zod schema, so a destination Dino will not scan
 * arrives as a `ZodError`. Unhandled, that reached the surface as a raw issue dump and exit 70 —
 * Dino reporting its own crash for a URL the user chose. The refusal is a policy, and the policy is
 * worth stating plainly.
 */
function resolveOne(
  config: VerificationTargetConfig,
  source: string,
  allowPrivateTarget: boolean | undefined,
): VerificationTarget {
  // `localhost` is reserved to mean loopback (RFC 6761) but is not an IP literal, so the address
  // check cannot judge it. Left to the wire it produced a scan that ran, reached nothing and
  // reported partial coverage — the refusal is the whole point, so make it here.
  const loopbackName = isLoopbackHostname(config.url);
  const check =
    loopbackName && allowPrivateTarget !== true
      ? ({ allowed: false, reason: 'blocked_ipv4' } as const)
      : checkEndpointUrl(config.url, { allowPrivateTarget });
  if (!check.allowed) {
    throw new CliError(
      `Cannot scan "${config.url}" (${source}): Dino does not send traffic to loopback, private, or reserved addresses.`,
      2,
      "Pass --allow-private-target to scan a service on your own machine or network. Link-local and cloud-metadata addresses stay blocked.",
      undefined,
      "usage",
    );
  }
  return resolveVerificationTarget(config, { allowPrivateTarget });
}

/** Validate every source, then apply explicit overrides without inheriting protection. */
export function resolveSelectedTarget(
  input: Readonly<{
    configured?: VerificationTargetConfig | undefined;
    flatEndpoint?: string | undefined;
    cliEndpoint?: string | undefined;
    /** Operator opt-in, from the command line only. */
    allowPrivateTarget: boolean;
  }>,
): VerificationTarget | undefined {
  const configured =
    input.configured === undefined
      ? undefined
      : resolveOne(input.configured, "tenant config", input.allowPrivateTarget);
  const flat =
    input.flatEndpoint === undefined
      ? undefined
      : resolveOne({ url: input.flatEndpoint }, ".dino.yml endpoint", input.allowPrivateTarget);
  const cli =
    input.cliEndpoint === undefined
      ? undefined
      : resolveOne({ url: input.cliEndpoint }, "--endpoint", input.allowPrivateTarget);
  return cli ?? flat ?? configured;
}
