/**
 * @dino/core — Universal Operation Type
 *
 * Represents a single API operation discovered via introspection or spec parsing.
 * GraphQL types only for now. REST/gRPC type literals will be added when a
 * plugin actually needs them.
 */

export interface Operation {
  /** Operation name (e.g., 'getUser', 'createPost') */
  name: string;

  /** Operation type — GraphQL only for now */
  type: 'query' | 'mutation' | 'subscription';

  /** Module this operation belongs to (e.g., 'auth', 'payment') */
  module?: string;

  /** Whether authentication is required */
  auth?: OperationAuth;

  /** Whether this operation is deprecated */
  deprecated?: boolean;

  /** Human-readable description */
  description?: string;
}

export interface OperationAuth {
  /** Whether authentication is required */
  required: boolean;

  /** Which roles can access this operation */
  roles?: string[];
}
