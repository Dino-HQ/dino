/**
 * DIN-1357 — the closed billing-handoff outcomes. Each code has one meaning on every surface and a bounded
 * NextAction; none of them is an entitlement decision (the commercial state is, DIN-1356). Leaf of `errors.ts`.
 */

import type { CredentialNextAction } from './credential-next-action';
import { DinoError, type DinoErrorCode } from './errors';

export type BillingOutcomeCode = Extract<DinoErrorCode, `BILLING_${string}`>;

const OUTCOMES: {
  readonly [C in BillingOutcomeCode]: { message: string; nextAction: CredentialNextAction };
} = {
  BILLING_PROVIDER_UNAVAILABLE: {
    message: 'The billing provider could not be reached; try again shortly',
    nextAction: { kind: 'retry', reasonCode: 'billing_provider_unavailable' },
  },
  BILLING_PROVIDER_NOT_CONFIGURED: {
    message: 'Billing is not configured for this Dino deployment',
    nextAction: { kind: 'contact_support', reasonCode: 'billing_provider_not_configured' },
  },
  BILLING_PROVIDER_REJECTED: {
    message: 'The billing provider refused the request',
    nextAction: { kind: 'contact_support', reasonCode: 'billing_provider_rejected' },
  },
  BILLING_CUSTOMER_NOT_FOUND: {
    message: 'This Organization has no billing account yet; choose a plan through checkout first',
    nextAction: { kind: 'provide_input', reasonCode: 'billing_plan_required' },
  },
  BILLING_CHECKOUT_OUTCOME_UNKNOWN: {
    message:
      'The billing provider never confirmed the checkout for this Idempotency-Key; start a new checkout with a new key',
    nextAction: { kind: 'provide_input', reasonCode: 'billing_checkout_outcome_unknown' },
  },
  BILLING_SUBSCRIPTION_EXISTS: {
    message: 'This Organization already has a subscription; change or cancel it in the billing portal',
    nextAction: { kind: 'provide_input', reasonCode: 'billing_subscription_exists' },
  },
  BILLING_RETURN_URL_NOT_ALLOWED: {
    message: 'successUrl must be an https URL on an allowed Dino origin',
    nextAction: { kind: 'provide_input', reasonCode: 'billing_return_url_not_allowed' },
  },
};

/** The typed error for a billing outcome, carrying its bounded NextAction. */
export function billingOutcomeError(code: BillingOutcomeCode, cause?: unknown): DinoError {
  const o = OUTCOMES[code];
  return new DinoError({
    code,
    message: o.message,
    meta: { nextAction: { ...o.nextAction } },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The NextAction an entitlement denial carries: a plan that includes the capability. */
export const PLAN_REQUIRED_NEXT_ACTION: CredentialNextAction = {
  kind: 'provide_input',
  reasonCode: 'billing_plan_required',
};
