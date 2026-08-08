/**
 * @dino/plugins — OpenAPI discovery plugin
 *
 * Wraps an OpenAPI parser behind the DiscoveryPlugin interface.
 * The parse function is injected (DI); no direct imports of @readme/openapi-parser.
 */

import { recordSet } from '@dino/core';
import { nameCollisionWarning, parsePartialWarning } from './warnings';
import type { DiscoveryPlugin, DiscoveryOptions, DiscoveryResult } from '../types';
import type {
  OpenAPIDocumentSource,
  OpenAPIPathItemSource,
  OpenAPIOperationSource,
  OpenAPIParseOptions,
} from './types';
import type { DiscoveryWarning } from './warnings';
import type {
  Operation,
  OperationParameter,
  OperationRequestBody,
  OperationResponseSchema,
} from '@dino/core';

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

const VALID_PARAM_IN = new Set(['path', 'query', 'header', 'cookie']);
const HTTP_STATUS_CODE = /^[1-5]\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractParameters(op: OpenAPIOperationSource): OperationParameter[] | undefined {
  if (!Array.isArray(op.parameters) || op.parameters.length === 0) return undefined;
  const out: OperationParameter[] = [];
  for (const raw of op.parameters) {
    if (!isRecord(raw)) continue;
    const name = raw.name;
    const inVal = raw.in;
    if (typeof name !== 'string' || name.trim() === '') continue;
    if (typeof inVal !== 'string' || !VALID_PARAM_IN.has(inVal)) continue;
    const param: OperationParameter = {
      name,
      in: inVal as OperationParameter['in'],
    };
    if (raw.required === true) param.required = true;
    if (typeof raw.description === 'string') param.description = raw.description;
    if (isRecord(raw.schema)) param.schema = raw.schema;
    out.push(param);
  }
  return out.length > 0 ? out : undefined;
}

function buildRequestBodyFromJson(
  rb: Record<string, unknown>,
  jsonContent: Record<string, unknown>,
): OperationRequestBody {
  if (jsonContent.schema !== undefined && !isRecord(jsonContent.schema)) {
    throw new Error('malformed request body schema');
  }
  const result: OperationRequestBody = { contentType: 'application/json' };
  if (rb.required === true) result.required = true;
  if (typeof rb.description === 'string') result.description = rb.description;
  if (isRecord(jsonContent.schema)) result.schema = jsonContent.schema;
  return result;
}

function buildRequestBodyFromContent(
  rb: Record<string, unknown>,
  content: Record<string, unknown>,
): OperationRequestBody | undefined {
  const jsonContent = content['application/json'];
  if (jsonContent !== undefined && isRecord(jsonContent)) {
    return buildRequestBodyFromJson(rb, jsonContent);
  }
  const firstType = Object.keys(content)[0];
  if (firstType === undefined) return undefined;
  const result: OperationRequestBody = { contentType: firstType };
  if (typeof rb.description === 'string') result.description = rb.description;
  if (rb.required === true) result.required = true;
  return result;
}

function extractRequestBody(op: OpenAPIOperationSource): OperationRequestBody | undefined {
  const rb = op.requestBody;
  if (!isRecord(rb)) return undefined;
  const content = rb.content;
  if (!isRecord(content)) return undefined;
  try {
    return buildRequestBodyFromContent(rb, content);
  } catch (err) {
    console.warn(
      JSON.stringify({ message: 'openapi_request_body_extract_failed', error: String(err) }),
    );
    return undefined;
  }
}

function parseResponseContent(
  content: Record<string, unknown>,
): Pick<OperationResponseSchema, 'contentType' | 'schema'> {
  const jsonContent = content['application/json'];
  if (jsonContent !== undefined && isRecord(jsonContent)) {
    const entry: Pick<OperationResponseSchema, 'contentType' | 'schema'> = {
      contentType: 'application/json',
    };
    if (isRecord(jsonContent.schema)) entry.schema = jsonContent.schema;
    return entry;
  }
  const firstType = Object.keys(content)[0];
  return firstType === undefined ? {} : { contentType: firstType };
}

function parseSingleResponse(resp: Record<string, unknown>): OperationResponseSchema | undefined {
  const entry: OperationResponseSchema = {};
  if (typeof resp.description === 'string') entry.description = resp.description;
  const content = resp.content;
  if (isRecord(content)) {
    Object.assign(entry, parseResponseContent(content));
  }
  return Object.keys(entry).length > 0 ? entry : undefined;
}

function extractResponseSchemas(
  op: OpenAPIOperationSource,
): Record<string, OperationResponseSchema> | undefined {
  const responses = op.responses;
  if (!isRecord(responses)) return undefined;
  const out: Record<string, OperationResponseSchema> = {};
  for (const [code, resp] of Object.entries(responses)) {
    if (!HTTP_STATUS_CODE.test(code) || !isRecord(resp)) continue;
    const entry = parseSingleResponse(resp);
    if (entry !== undefined) recordSet(out, code, entry);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * First meaningful path segment for module fallback (#208).
 * Skips leading version prefixes (`v1`, `v2`, …) and `{param}` segments.
 */
function pathModuleFallback(path: string): string | undefined {
  const segments = path.split('/').filter((s) => s.length > 0 && !s.startsWith('{'));
  const withoutLeadingVersions = [...segments];
  while (withoutLeadingVersions.length > 0 && /^v\d+$/i.test(withoutLeadingVersions.at(0) ?? '')) {
    withoutLeadingVersions.shift();
  }
  const candidate = withoutLeadingVersions.at(0);
  return candidate !== undefined && candidate.length > 0 ? candidate : undefined;
}

function toOperation(method: HttpMethod, path: string, op: OpenAPIOperationSource): Operation {
  const rawId = op.operationId;
  const resolvedName =
    typeof rawId === 'string' && rawId.trim() !== '' ? rawId : generateOperationName(method, path);
  const parameters = extractParameters(op);
  const requestBody = extractRequestBody(op);
  const responseSchemas = extractResponseSchemas(op);
  const tagModule =
    Array.isArray(op.tags) && typeof op.tags[0] === 'string' && op.tags[0].trim() !== ''
      ? op.tags[0].trim()
      : undefined;
  const module = tagModule ?? pathModuleFallback(path);
  return {
    name: resolvedName,
    type: 'rest',
    method: method.toUpperCase() as Operation['method'],
    path,
    description: pickDescription(op),
    deprecated: op.deprecated ?? false,
    ...(module === undefined ? {} : { module }),
    ...(parameters === undefined ? {} : { parameters }),
    ...(requestBody === undefined ? {} : { requestBody }),
    ...(responseSchemas === undefined ? {} : { responseSchemas }),
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
