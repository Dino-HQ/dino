import { z } from "zod";
import {
  checkEndpointUrl,
  ENDPOINT_REJECT_MESSAGES,
  type EndpointPolicyOptions,
} from "./endpoint-validator";

export type VerificationTargetConfig = Readonly<{
  url: string;
  protected?: boolean | undefined;
}>;
export type VerificationTarget = Readonly<{ url: string; protected: boolean }>;
export type VerificationTargets = Readonly<{
  graphql?: VerificationTarget | undefined;
  rest?: VerificationTarget | undefined;
}>;

const endpointUrlSchema = (policy: EndpointPolicyOptions) =>
  z.string().superRefine((url, context) => {
    const result = checkEndpointUrl(url, policy);
    if (!result.allowed) context.addIssue(ENDPOINT_REJECT_MESSAGES[result.reason]);
  });

const EndpointUrlSchema = endpointUrlSchema({});

export const VerificationTargetSchema = z
  .object({
    url: EndpointUrlSchema,
    protected: z.boolean().default(true),
  })
  .strict();

/**
 * ADMIT a destination: check the URL against the policy, and default `protected`.
 *
 * `policy` is required. It used to default to the strict policy, which made an omitted argument
 * indistinguishable from a deliberate one — and four planners then re-ran this on an
 * already-admitted target with no policy at all, so a loopback URL the operator had opted into was
 * refused again, deep inside the run, by a call that had no way of knowing about the opt-in.
 *
 * Call this where a destination is CHOSEN. Somewhere that only needs `protected` filled in should
 * call {@link normalizeVerificationTarget}, which does not re-decide the destination.
 */
export function resolveVerificationTarget(
  config: VerificationTargetConfig,
  policy: EndpointPolicyOptions,
): VerificationTarget {
  const schema =
    policy.allowPrivateTarget === true
      ? z.object({ url: endpointUrlSchema(policy), protected: z.boolean().default(true) }).strict()
      : VerificationTargetSchema;
  return Object.freeze(schema.parse(config));
}

/**
 * Fill in `protected` without re-deciding the destination.
 *
 * The destination is admitted ONCE, where it is chosen, by whoever holds the operator's policy.
 * A planner deep in a run holds neither, so re-checking there could only ever be stricter than the
 * decision already made — defence in depth against the wrong policy is not defence, it is the
 * admitted target being refused by its own pipeline. What a planner does need is the safe default
 * for `protected`, since an unset flag must never read as "safe to send writes to".
 */
export function normalizeVerificationTarget(config: VerificationTargetConfig): VerificationTarget {
  return Object.freeze({ url: config.url, protected: config.protected ?? true });
}

/**
 * What a tenant file may NAME, which is not the same question as where a run may SEND.
 *
 * `loadTenantById` validates EVERY environment of a tenant file, long before the CLI has parsed
 * `--allow-private-target` and before `--endpoint` could override the selection. Admitting there
 * under the strict policy refused to load a whole tenant because one environment named a loopback
 * address — which is exactly what a `local` environment is FOR.
 *
 * So this schema asks the weaker question: could this address EVER be a legitimate destination for
 * anyone? Loopback and RFC1918 can, for an operator scanning their own machine, so they load and
 * the real decision is deferred to {@link resolveVerificationTarget} once the policy is known.
 * Link-local/metadata, `0.0.0.0`, TEST-NET and the other reserved ranges never can, for anyone,
 * under any flag — so a tenant file naming one is still refused here, at load, as it always was.
 */
export const TenantEndpointSchema = z
  .object({
    url: endpointUrlSchema({ allowPrivateTarget: true }),
    protected: z.boolean().default(true),
  })
  .strict();
