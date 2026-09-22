import { resolveTenantConfigDir, type TenantConfig, type VerificationTarget } from '@dino/core';
import { createDiscoveryBridge } from '@dino/engine';

/** Tenant-scoped discovery plugin with configDir for SDL schemaPath containment (#2306). */
export function createTenantDiscoveryBridge(
  tenant: TenantConfig,
  environment: string,
  allowPrivateTarget: boolean,
  target?: VerificationTarget | undefined,
) {
  return createDiscoveryBridge({
    tenant,
    environment,
    target,
    configDir: resolveTenantConfigDir(),
    allowPrivateTarget,
  });
}
