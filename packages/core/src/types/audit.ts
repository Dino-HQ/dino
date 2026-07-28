/**
 * Audit event domain types.
 *
 * AuditEvent is the domain contract — what the platform means by an audit
 * event. The Drizzle persistence shape (auditEvents table) lives in
 * @dino/cloud and has its own concerns (text metadata column, integer
 * timestamps). This type is the product contract, not the storage model.
 */

import type { TenantId } from './ids';

/** Actions that produce audit trail entries. */
export type AuditAction =
  // Tenant lifecycle
  | 'tenant.created'
  | 'tenant.updated'
  | 'tenant.member.invited'
  // Member lifecycle
  | 'member.removed'
  | 'member.role_changed'
  | 'member.profile_created'
  | 'member.2fa.reset'
  // Scan lifecycle
  | 'scan.created'
  | 'scan.retried'
  | 'scan.cancel_requested'
  // Settings
  | 'settings.updated'
  | 'settings.ai.updated'
  | 'settings.ai.deleted'
  | 'settings.2fa.updated'
  | 'settings.2fa.self_unenrolled'
  | 'workspace.deletion_requested'
  | 'workspace.deletion_blocked_active_subscription'
  | 'workspace.export_requested'
  // Sentinel
  | 'sentinel.settings.updated'
  | 'sentinel.signal.acknowledged'
  | 'sentinel.signal.dismissed'
  | 'sentinel.signal.snoozed'
  | 'sentinel.signal.feedback_created'
  | 'sentinel.signal_reviewed'
  | 'sentinel.check_run_created'
  | 'sentinel.pr_report_posted'
  // Runner lifecycle
  | 'runner.auth_hydrated'
  | 'runner.registered'
  | 'runner.revoked'
  | 'runner.oidc.updated'
  | 'runner.job.claimed'
  | 'runner.job.completed'
  | 'runner.job.auth_retry'
  | 'runner.job.failed'
  | 'runner.job.cancelled'
  | 'runner.result.submitted'
  | 'runner.result.rejected'
  | 'runner.attestation.submitted'
  // Pool runners (#68)
  | 'runner.pool.assigned'
  | 'runner.pool.claimed'
  // Managed runners (admin API)
  | 'runner.managed.created'
  | 'runner.managed.stopped'
  | 'runner.managed.started'
  | 'runner.managed.restarted'
  | 'runner.managed.deleted'
  | 'runner.managed.orphaned'
  | 'runner.health_degraded'
  // Intelligence
  | 'intelligence.query.created'
  // Findings
  | 'finding.shared'
  | 'finding.suppressed'
  | 'finding.unsuppressed'
  | 'finding.status_changed'
  // Quality gates (#64)
  | 'quality_gate.default_changed'
  // Quick setup
  | 'quick_setup.completed'
  // API activation (#1277)
  | 'api.created'
  | 'api.updated'
  | 'api.deleted'
  // API baseline (#1366 Bundle E2)
  | 'baseline.pinned'
  | 'baseline.unpinned'
  | 'api_environment.created'
  | 'api_environment.updated'
  | 'api_environment.deleted'
  | 'auth_profile.created'
  | 'auth_profile.updated'
  | 'auth_profile.deleted'
  | 'auth_profile.ropc_rejected'
  | 'auth_profile.oauth2_exchange_failed'
  | 'auth.detect'
  | 'oauth2.token_rotated'
  | 'oauth2.token_rotation_persist_failed'
  | 'crypto.credential_reencrypted'
  // Runner enablement (#1419 Bundle B)
  | 'token_factory_profile.created'
  | 'token_factory_profile.updated'
  | 'token_factory_profile.deleted'
  | 'runner_profile.created'
  | 'runner_profile.updated'
  | 'runner_profile.deleted'
  | 'runner.updated'
  // API keys (#1419)
  | 'api_key.created'
  | 'api_key.regenerated'
  | 'api_key.revoked'
  // Billing + Workspace Lifecycle (#1419 Bundle C)
  | 'member.preferences_updated'
  | 'billing.checkout_created'
  | 'billing.portal_created'
  | 'billing.tier_changed'
  | 'billing.customer_linked'
  | 'billing.cancellation_scheduled'
  | 'billing.seats_changed'
  | 'billing.customer_mismatch'
  // GitHub installation lifecycle
  | 'github_installation.created'
  | 'github_installation.deleted'
  | 'github_installation.suspended'
  | 'github_installation.unsuspended'
  // System alerts
  | 'system.durable_write_dead';

/**
 * Actor types in the audit trail.
 * `admin` is legacy rows; new admin-key events use `admin_api`.
 */
export type AuditActorType = 'member' | 'runner' | 'admin' | 'admin_api' | 'system';

/** Resource types tracked by audit events. */
export type AuditResourceType =
  | 'tenant'
  | 'member'
  | 'runner'
  | 'scan'
  | 'result'
  | 'settings'
  | 'signal'
  | 'finding'
  | 'intelligence'
  | 'api'
  | 'api_environment'
  | 'auth_profile'
  | 'token_factory_profile'
  | 'runner_profile'
  | 'api_key'
  | 'workspace'
  | 'billing'
  | 'github_installation'
  | 'system';

/**
 * Domain audit event — the product contract for audit trail entries.
 *
 * This is what "an audit event" means in Dino's domain model. The cloud
 * persistence layer maps this to a Drizzle row with serialized metadata
 * and integer timestamps.
 */
export interface AuditEvent {
  tenantId: TenantId;
  actorType: AuditActorType;
  actorId: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  metadata?: Record<string, unknown> | undefined;
}
