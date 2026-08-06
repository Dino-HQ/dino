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
   * For REST, this is the protocol marker — semantic intent for REST
   * is derived from `method` by consuming agents (Spec 5+).
   */
  type: 'query' | 'mutation' | 'subscription' | 'rest';

  /** Module this operation belongs to (e.g., 'auth', 'payment'). */
  module?: string | undefined;

  /** Whether authentication is required. */
  auth?: OperationAuth | undefined;

  /** Whether this operation is deprecated. */
  deprecated?: boolean | undefined;

  /** Human-readable description. */
  description?: string | undefined;

  /** REST only: HTTP method. Populated by the OpenAPI plugin in Spec 2. */
  method?: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS') | undefined;

  /** REST only: URL path template (e.g. '/users/{id}'). Populated in Spec 2. */
  path?: string | undefined;

  /** OpenAPI declared parameters (path, query, header, cookie). */
  parameters?: OperationParameter[] | undefined;

  /** OpenAPI declared request body schema. */
  requestBody?: OperationRequestBody | undefined;

  /** OpenAPI declared response schemas keyed by status code. */
  responseSchemas?: Record<string, OperationResponseSchema> | undefined;

  /** gRPC only: streaming mode. Reserved for Spec 2+ gRPC work. */
  rpcMode?: ('unary' | 'server-stream' | 'client-stream' | 'bidi-stream') | undefined;
}

export interface OperationParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface OperationRequestBody {
  contentType: string;
  schema?: Record<string, unknown>;
  required?: boolean;
  description?: string;
}

export interface OperationResponseSchema {
  description?: string;
  contentType?: string;
  schema?: Record<string, unknown>;
}

export interface OperationAuth {
  /** Whether authentication is required. */
  required: boolean;

  /** Which roles can access this operation. */
  roles?: string[] | undefined;
}
