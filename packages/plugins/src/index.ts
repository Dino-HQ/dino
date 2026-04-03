// @dino/plugins — API discovery and auth adapter plugins

export type { DiscoveryOptions, DiscoveryLogger, DiscoveryResult, DiscoveryPlugin } from './types';

export { createGraphQLDiscoveryPlugin } from './graphql';
export type {
  GraphQLDiscoveryPluginDeps,
  GraphQLIntrospectOptions,
  GraphQLIntrospectionSource,
} from './graphql';
