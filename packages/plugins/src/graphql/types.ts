/**
 * @dino/plugins — GraphQL discovery plugin types
 *
 * Tenant-agnostic options and minimal introspection shape for DI.
 * The host provides an introspect function that returns at least this shape.
 */

/**
 * Options for the GraphQL introspection call. Injected by the host (e.g. from tenant config).
 */
export interface GraphQLIntrospectOptions {
  /** GraphQL endpoint URL. */
  endpoint: string;

  /** Request timeout in milliseconds. */
  timeout?: number | undefined;

  /** Optional headers (e.g. Authorization: Bearer <token>). */
  headers?: Record<string, string> | undefined;
}

/**
 * Minimal shape returned by the injected introspect function.
 * The host's full IntrospectionResult satisfies this (has operations with these fields).
 */
export interface GraphQLIntrospectionSource {
  operations: Array<{
    name: string;
    type: 'query' | 'mutation' | 'subscription';
    description?: (string | null) | undefined;
    isDeprecated?: boolean | undefined;
    deprecationReason?: (string | null) | undefined;
  }>;
}
