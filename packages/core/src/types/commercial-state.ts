/**
 * DIN-1356 — the Organization's canonical commercial state: what plan it is on, where its billing-provider
 * subscription stands, which capabilities that plan entitles, how much allowance remains, and whether the
 * billing provider is reachable from Dino. The axes stay separate; none of them is API connectivity, Target
 * health, a verification result or readiness, and there is deliberately no combined `ready` value.
 */

import { z } from 'zod';
import type { CredentialNextAction } from '../credential-next-action';
import type { FeatureKey, GateType, TierName } from './entitlement';

/**
 * Where the billing-provider subscription stands, from Dino's materialized snapshot (never a live provider call):
 * - `none`: no billing-provider customer and no subscription — the Organization has never subscribed.
 * - `unknown`: a customer is bound but no subscription snapshot has arrived yet. Honest unknown, not `none`.
 * - `active`: the subscription renews.
 * - `cancel_scheduled`: still active, ends at `currentPeriodEnd`.
 * - `action_required`: payment needs the customer (past due, unpaid, incomplete); the plan is kept meanwhile.
 * - `ended`: the subscription was revoked or has ended.
 */
export const COMMERCIAL_SUBSCRIPTION_STATES = [
  'none',
  'unknown',
  'active',
  'cancel_scheduled',
  'action_required',
  'ended',
] as const;
export type CommercialSubscriptionState = (typeof COMMERCIAL_SUBSCRIPTION_STATES)[number];

/** Whether Dino is configured to reach the billing provider. It is not a live health check. */
export const BILLING_PROVIDER_AVAILABILITY = ['available', 'not_configured'] as const;
export type BillingProviderAvailability = (typeof BILLING_PROVIDER_AVAILABILITY)[number];

export type CommercialFeatureEntitlementView = {
  readonly gate: GateType | 'none';
  readonly allowed: boolean;
  readonly upgradeMessage: string | null;
};

/** Allowance of one metered capability. `limit` and `remaining` null = unlimited. */
export type CommercialUsageView = {
  readonly feature: FeatureKey;
  readonly used: number;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetDate: string | null;
};

export type CommercialStateView = {
  readonly organizationId: string;
  readonly plan: { readonly tier: TierName };
  readonly subscription: {
    readonly state: CommercialSubscriptionState;
    /** The billing provider's own status string, verbatim; null when none was recorded. */
    readonly providerStatus: string | null;
    readonly currentPeriodEnd: string | null;
    readonly cancelAtPeriodEnd: boolean;
  };
  readonly entitlements: Readonly<Record<FeatureKey, CommercialFeatureEntitlementView>>;
  readonly usage: readonly CommercialUsageView[];
  readonly provider: { readonly availability: BillingProviderAvailability };
  /** What the customer must do next, when anything; null otherwise. Grants no authority. */
  readonly nextAction: CredentialNextAction | null;
};

/** MCP `get_commercial_state`: no arguments — the Organization is the caller's own. */
export const CommercialStateRefSchema = z.object({}).strict();
