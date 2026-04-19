/**
 * @dino/plugins — OpenAPI discovery plugin
 *
 * Wraps an OpenAPI parser behind the DiscoveryPlugin interface.
 * The parse function is injected (DI); no direct imports of @readme/openapi-parser.
 */

import type { Operation } from '@dino/core';
import type { DiscoveryPlugin, DiscoveryOptions, DiscoveryResult } from '../types';
import type {
  OpenAPIDocumentSource,
  OpenAPIPathItemSource,
  OpenAPIOperationSource,
  OpenAPIParseOptions,
} from './types';
import type { DiscoveryWarning } from './warnings';
import { nameCollisionWarning, parsePartialWarning } from './warnings';

/**
 * Dependencies for the OpenAPI discovery plugin. All injected; no globals.
 */
export interface OpenAPIDiscoveryPluginDeps {
  /**
   * Parse and dereference an OpenAPI spec at the given path (URL or file).
   * Typically wraps @readme/openapi-parser's dereference() in production.
   * Options (timeout, headers) are forwarded from DiscoveryOptions for URL-sourced specs.
   */
  parse: (specPath: string, opts?: OpenAPIParseOptions) => Promise<OpenAPIDocumentSource>;

  /**
   * Whether the parse function resolves external $ref (file/URL).
   * Security decision — set once at construction, not per-call.
   * Default: false (external refs left unresolved). Host reads this; the plugin does not resolve refs.
   */
  resolveExternalRefs?: boolean;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

const noop = (): void => {};

function pickDescription(op: OpenAPIOperationSource): string | undefined {
  if (typeof op.description === 'string' && op.description.trim().length > 0) {
    return op.description;
  }
  if (typeof op.summary === 'string' && op.summary.trim().length > 0) {
    return op.summary;
  }
  return undefined;
}

/**
 * Generate an operation name from HTTP method + path when operationId is absent.
 * GET /users/{id}/posts → getUsersIdPosts
 */
function generateOperationName(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => s.replaceAll(/[{}]/g, ''));
  const capitalized = segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return method.toLowerCase() + capitalized.join('');
}

function operationForMethod(
  pathItem: OpenAPIPathItemSource,
  method: HttpMethod,
): OpenAPIOperationSource | undefined {
  switch (method) {
    case 'get':
      return pathItem.get;
    case 'post':
      return pathItem.post;
    case 'put':
      return pathItem.put;
    case 'patch':
      return pathItem.patch;
    case 'delete':
      return pathItem.delete;
    case 'head':
      return pathItem.head;
    case 'options':
      return pathItem.options;
    default: {
      const _exhaustive: never = method;
      return _exhaustive;
    }
  }
}

function toOperation(method: HttpMethod, path: string, op: OpenAPIOperationSource): Operation {
  const rawId = op.operationId;
  const resolvedName =
    typeof rawId === 'string' && rawId.trim() !== '' ? rawId : generateOperationName(method, path);
  return {
    name: resolvedName,
    type: 'rest',
    method: method.toUpperCase() as Operation['method'],
    path,
    description: pickDescription(op),
    deprecated: op.deprecated ?? false,
  };
}

function assertSpecPath(options: DiscoveryOptions): string {
  if (options.specPath === undefined || options.specPath === null) {
    throw new Error('OpenAPI discovery requires specPath in options');
  }
  if (options.specPath.trim() === '') {
    throw new Error('OpenAPI discovery requires specPath in options');
  }
  return options.specPath;
}

function collectNameCollisions(operations: Operation[]): DiscoveryWarning[] {
  const nameIndex = new Map<string, Array<{ method: string; path: string }>>();
  for (const op of operations) {
    const existing = nameIndex.get(op.name) ?? [];
    existing.push({
      method: op.method ?? 'UNKNOWN',
      path: op.path ?? 'UNKNOWN',
    });
    nameIndex.set(op.name, existing);
  }
  const out: DiscoveryWarning[] = [];
  for (const [name, paths] of nameIndex) {
    if (paths.length > 1) {
      out.push(nameCollisionWarning(name, paths));
    }
  }
  return out;
}

async function discoverOperations(
  deps: OpenAPIDiscoveryPluginDeps,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const parse = deps.parse;
  const log = options.logger?.info?.bind(options.logger) ?? noop;
  const specPath = assertSpecPath(options);

  log(`Discovering operations from ${specPath}`);

  const api = await parse(specPath, {
    timeout: options.timeout,
    headers: options.headers,
  });
  const operations: Operation[] = [];
  const warnings: DiscoveryWarning[] = [];
  let skippedPathItems = 0;

  if (api.paths) {
    for (const [path, pathItemRaw] of Object.entries(api.paths)) {
      if (pathItemRaw == null || typeof pathItemRaw !== 'object') {
        skippedPathItems++;
        continue;
      }
      const pathItem: OpenAPIPathItemSource = pathItemRaw;
      for (const method of HTTP_METHODS) {
        const op = operationForMethod(pathItem, method);
        if (op) {
          operations.push(toOperation(method, path, op));
        }
      }
    }
  }

  if (skippedPathItems > 0) {
    warnings.push(parsePartialWarning(skippedPathItems, 'non-object path item'));
  }

  warnings.push(...collectNameCollisions(operations));

  log(`Discovery complete: ${operations.length} operations`);

  return { operations, warnings, raw: api };
}

/**
 * Create an OpenAPI discovery plugin that uses the given parse function.
 *
 * @param deps - Injected parse function (wraps @readme/openapi-parser or mock)
 * @returns DiscoveryPlugin implementation
 */
export function createOpenAPIDiscoveryPlugin(deps: OpenAPIDiscoveryPluginDeps): DiscoveryPlugin {
  return {
    id: 'openapi',
    discover: (opts: DiscoveryOptions) => discoverOperations(deps, opts),
  };
}
