/**
 * @dino/core — Universal Operation Type
 *
 * Represents a single API operation discovered via introspection or spec parsing.
 * Protocol-extensible: REST and gRPC are values on the `type` union.
 */

export interface Operation {
  /** Operation name (e.g., 'getUser', 'createPost'). */
  name: string;

  /**
   * Operation type. For GraphQL, this is the query kind.
   * For REST / gRPC, this is the protocol marker — semantic intent for REST
   * is derived from `method` by consuming agents (Spec 5+).
   */
  type: 'query' | 'mutation' | 'subscription' | 'rest' | 'grpc';

  /** Module this operation belongs to (e.g., 'auth', 'payment'). */
  module?: string;

  /** Whether authentication is required. */
  auth?: OperationAuth;

  /** Whether this operation is deprecated. */
  deprecated?: boolean;

  /** Human-readable description. */
  description?: string;

  /** REST only: HTTP method. Populated by the OpenAPI plugin in Spec 2. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

  /** REST only: URL path template (e.g. '/users/{id}'). Populated in Spec 2. */
  path?: string;

  /** gRPC only: streaming mode. Reserved for Spec 2+ gRPC work. */
  rpcMode?: 'unary' | 'server-stream' | 'client-stream' | 'bidi-stream';
}

export interface OperationAuth {
  /** Whether authentication is required. */
  required: boolean;

  /** Which roles can access this operation. */
  roles?: string[];
}
