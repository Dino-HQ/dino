/**
 * @dino/plugins — GraphQL discovery plugin
 *
 * Wraps an introspection engine behind the DiscoveryPlugin interface.
 * The introspect function is injected (DI); no direct imports of app config or Circo.
 */

import type { Operation } from '@dino/core';
import type { DiscoveryPlugin, DiscoveryOptions, DiscoveryResult } from '../types';
import type { GraphQLIntrospectOptions, GraphQLIntrospectionSource } from './types';

/**
 * Dependencies for the GraphQL discovery plugin. All injected; no globals.
 */
export interface GraphQLDiscoveryPluginDeps {
  /**
   * Run GraphQL introspection against the given endpoint.
   * Typically provided by the host (e.g. wrapping src/introspection/introspect with tenant-derived options).
   */
  introspect: (opts: GraphQLIntrospectOptions) => Promise<GraphQLIntrospectionSource>;
}

const noop = (): void => {};

function toOperation(op: GraphQLIntrospectionSource['operations'][number]): Operation {
  return {
    name: op.name,
    type: op.type,
    description: op.description ?? undefined,
    deprecated: op.isDeprecated ?? false,
  };
}

async function discoverOperations(
  introspect: GraphQLDiscoveryPluginDeps['introspect'],
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const log = options.logger?.info?.bind(options.logger) ?? noop;
  log(`Discovering operations from ${options.endpoint}`);

  const result = await introspect({
    endpoint: options.endpoint,
    timeout: options.timeout,
    headers: options.headers,
  });
  const operations: Operation[] = result.operations.map(toOperation);
  log(`Discovery complete: ${operations.length} operations`);

  return { operations, warnings: [], raw: result };
}

/**
 * Create a GraphQL discovery plugin that uses the given introspect function.
 *
 * @param deps - Injected introspect function (tenant-agnostic)
 * @returns DiscoveryPlugin implementation
 */
export function createGraphQLDiscoveryPlugin(deps: GraphQLDiscoveryPluginDeps): DiscoveryPlugin {
  return {
    id: 'graphql',
    discover: (options: DiscoveryOptions) => discoverOperations(deps.introspect, options),
  };
}
