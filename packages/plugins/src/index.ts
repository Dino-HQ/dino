// @dino/plugins — API discovery and auth adapter plugins

export type { DiscoveryOptions, DiscoveryLogger, DiscoveryResult, DiscoveryPlugin } from './types';

export { createGraphQLDiscoveryPlugin } from './graphql';
export type {
  GraphQLDiscoveryPluginDeps,
  GraphQLIntrospectOptions,
  GraphQLIntrospectionSource,
} from './graphql';

export { createOpenAPIDiscoveryPlugin } from './openapi';
export type {
  OpenAPIDiscoveryPluginDeps,
  OpenAPIDocumentSource,
  OpenAPIPathItemSource,
  OpenAPIOperationSource,
  OpenAPIParseOptions,
} from './openapi';
export type { DiscoveryWarning, DiscoveryWarningCode } from './openapi';
export { nameCollisionWarning, parsePartialWarning } from './openapi';
