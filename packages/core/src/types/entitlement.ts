export const TIER_NAMES = ['free', 'pro', 'team', 'enterprise'] as const;
export type TierName = (typeof TIER_NAMES)[number];

export const FEATURE_KEYS = [
  'scans',
  'ai_requests',
  'apis',
  'environments',
  'auth_profiles',
  'runners_managed',
  'team_members',
  'ai_chat',
  'ai_reasoning',
  'sentinel_levels',
  'runner_compute',
  'snapshots',
  'signals_visible',
  'custom_rules',
  'dashboard',
  'sso',
  'scim',
  'audit_logs',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const GATE_TYPES = ['boolean', 'numeric', 'allowlist'] as const;
export type GateType = (typeof GATE_TYPES)[number];

export interface EntitlementResult {
  allowed: boolean;
  used: number;
  limit: number | null;
  remaining: number;
  resetDate: string | null;
  upgradeMessage?: string;
}
