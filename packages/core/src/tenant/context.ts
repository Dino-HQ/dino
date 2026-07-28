/**
 * @dino/core — AgentContext Factory
 *
 * Builds an AgentContext from tenant config + operation list.
 * The context is the primary input to every agent — it provides
 * everything an agent needs to run against a specific tenant.
 */

import { recordGet } from '../utils/safe-record';
import type { TenantConfig, EnvironmentConfig } from './tenant-config';
import type { Operation } from '../types/operation';

/**
 * The runtime context passed to every agent.
 * Contains the tenant config, resolved environment, and operation list.
 */
export interface AgentContext {
  /** Tenant configuration */
  tenant: TenantConfig;

  /** Resolved environment config (from tenant.defaultEnvironment) */
  environment: EnvironmentConfig;

  /** Discovered operations from the API */
  operations: Operation[];
}

export interface CreateAgentContextOptions {
  /** Tenant configuration */
  tenant: TenantConfig;

  /** Operations discovered from the API */
  operations?: Operation[];

  /** Override the default environment */
  environmentOverride?: string;
}

/**
 * Create an AgentContext from tenant config and discovered operations.
 *
 * @param options - Tenant config and optional overrides
 * @returns AgentContext ready for agent consumption
 * @throws Error if the resolved environment is not found in tenant config
 */
export function createAgentContext(options: CreateAgentContextOptions): AgentContext {
  const { tenant, operations = [], environmentOverride } = options;

  const envName = environmentOverride ?? tenant.defaultEnvironment;
  const environment = recordGet(tenant.environments, envName);

  if (!environment) {
    const available = Object.keys(tenant.environments).join(', ');
    throw new Error(
      `Environment "${envName}" not found in tenant "${tenant.id}". Available: ${available}`,
    );
  }

  return {
    tenant,
    environment,
    operations,
  };
}
