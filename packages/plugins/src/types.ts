/**
 * @dino/plugins — Discovery plugin interface
 *
 * Minimal contract for a plugin that discovers API operations from a live source
 * (e.g. GraphQL introspection). Tenant-agnostic; no Circo or env references.
 * All dependencies are passed via options (DI).
 */

import type { Operation } from '@dino/core';

/**
 * Options passed into a discovery plugin. All inputs are injected; no global config.
 */
export interface DiscoveryOptions {
  /** API endpoint URL (e.g. GraphQL endpoint). */
  endpoint: string;

  /** Request timeout in milliseconds. */
  timeout?: number;

  /** Optional headers (e.g. Authorization). */
  headers?: Record<string, string>;

  /** Optional logger; plugin may no-op if absent. */
  logger?: DiscoveryLogger;
}

/**
 * Minimal logger interface for plugin use. Caller can pass a no-op or real logger.
 */
export interface DiscoveryLogger {
  info?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
}

/**
 * Result of a discovery run. Operations use core Operation type (tenant-agnostic).
 */
export interface DiscoveryResult {
  /** Discovered operations in core shape (name, type, description?, deprecated?, etc.). */
  operations: Operation[];

  /** Optional plugin-specific payload (e.g. full introspection for tools that need inputTypes/enumTypes). */
  raw?: unknown;
}

/**
 * Contract for a discovery plugin. Any plugin that discovers operations must implement this.
 */
export interface DiscoveryPlugin {
  /** Stable plugin identifier (e.g. 'graphql'). */
  id: string;

  /**
   * Discover operations from the configured source.
   * All inputs (endpoint, timeout, headers, logger) come from options.
   */
  discover(options: DiscoveryOptions): Promise<DiscoveryResult>;
}
