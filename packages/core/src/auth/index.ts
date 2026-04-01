/**
 * @dino/core — Auth types and interfaces
 *
 * Phase 3b: Forward-looking barrel. Auth implementation remains in src/shared/auth/.
 * These re-exports allow downstream consumers to import from @dino/core/auth
 * once migration is complete.
 */

// Re-export tenant config auth types (already in core)
export type { AuthConfig, RoleConfig, TokenRefreshConfig } from '../tenant/tenant-config';
