/**
 * @dino/plugins — OpenAPI discovery plugin types
 *
 * Tenant-agnostic types for the OpenAPI parser DI seam.
 * The host provides a parse function that returns at least this shape.
 */

/**
 * Options passed to the injected parse function.
 */
export interface OpenAPIParseOptions {
  /** Request timeout for URL-sourced specs, in milliseconds. */
  timeout?: number | undefined;
  /** Optional headers for URL-sourced specs (e.g. Authorization). */
  headers?: Record<string, string> | undefined;
}

/**
 * Minimal shape returned by the injected parse function.
 * @readme/openapi-parser's dereference() returns a superset of this.
 * The plugin only reads these fields — everything else is passed through as `raw`.
 */
export interface OpenAPIDocumentSource {
  /** OpenAPI version string (e.g. "3.0.3", "3.1.0"). */
  openapi: string;
  /** Spec metadata. */
  info: { title: string; version: string };
  /** Path items keyed by URL template. May be absent in edge-case specs. */
  paths?: Record<string, OpenAPIPathItemSource> | undefined;

  /** Server URLs from the spec. Used by the executor (Spec 4) to resolve base URLs. */
  servers?:
    | Array<{
        url: string;
        description?: string | undefined;
        variables?: Record<string, { default: string; enum?: string[] | undefined }> | undefined;
      }>
    | undefined;
}

/**
 * Minimal path item shape. Only HTTP method fields are read.
 */
export interface OpenAPIPathItemSource {
  get?: OpenAPIOperationSource | undefined;
  post?: OpenAPIOperationSource | undefined;
  put?: OpenAPIOperationSource | undefined;
  patch?: OpenAPIOperationSource | undefined;
  delete?: OpenAPIOperationSource | undefined;
  head?: OpenAPIOperationSource | undefined;
  options?: OpenAPIOperationSource | undefined;
}

/**
 * Minimal operation shape. Only fields needed for Operation mapping are typed.
 */
export interface OpenAPIOperationSource {
  /** Unique operation identifier. Used as Operation.name when present. */
  operationId?: string | undefined;
  /** Short summary. Fallback for description. */
  summary?: string | undefined;
  /** Longer description. Preferred over summary for Operation.description. */
  description?: string | undefined;
  /** OpenAPI tags — first tag becomes Operation.module (#208). */
  tags?: string[] | undefined;
  /** Whether this operation is deprecated. */
  deprecated?: boolean | undefined;
  /** Declared operation parameters. */
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: Record<string, unknown>;
  }>;
  /** Declared request body. */
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  /** Declared responses keyed by status code. */
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: Record<string, unknown> }>;
    }
  >;
}
