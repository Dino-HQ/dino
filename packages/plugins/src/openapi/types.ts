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
  timeout?: number;
  /** Optional headers for URL-sourced specs (e.g. Authorization). */
  headers?: Record<string, string>;
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
  paths?: Record<string, OpenAPIPathItemSource>;

  /** Server URLs from the spec. Used by the executor (Spec 4) to resolve base URLs. */
  servers?: Array<{
    url: string;
    description?: string;
    variables?: Record<string, { default: string; enum?: string[] }>;
  }>;
}

/**
 * Minimal path item shape. Only HTTP method fields are read.
 */
export interface OpenAPIPathItemSource {
  get?: OpenAPIOperationSource;
  post?: OpenAPIOperationSource;
  put?: OpenAPIOperationSource;
  patch?: OpenAPIOperationSource;
  delete?: OpenAPIOperationSource;
  head?: OpenAPIOperationSource;
  options?: OpenAPIOperationSource;
}

/**
 * Minimal operation shape. Only fields needed for Operation mapping are typed.
 */
export interface OpenAPIOperationSource {
  /** Unique operation identifier. Used as Operation.name when present. */
  operationId?: string;
  /** Short summary. Fallback for description. */
  summary?: string;
  /** Longer description. Preferred over summary for Operation.description. */
  description?: string;
  /** Whether this operation is deprecated. */
  deprecated?: boolean;
}
