/**
 * @dino/cli — Load .dino.yml via cosmiconfig
 */

import path from 'node:path';
import { cosmiconfig } from 'cosmiconfig';
import { z } from 'zod';
import { CliError } from '../shared/errors';

// B99 (#668): Zod schema for .dino.yml validation
// #2160/#2161: auth is a union: none | header-token | oauth2 | legacy {enabled,role}
const FlatAuthSchema = z.union([
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('header'),
    header: z.string().min(1),
    scheme: z.string().min(1).optional(),
    valueEnv: z.string().min(1),
  }),
  z.object({
    type: z.literal('oauth2'),
    tokenEndpoint: z.url(),
    clientIdEnv: z.string().min(1),
    clientSecretEnv: z.string().min(1),
    scope: z.string().min(1).optional(),
  }),
  z.object({
    enabled: z.boolean(),
    role: z.string().min(1).optional(),
  }),
]);

const DinoCliConfigSchema = z.looseObject({
  tenant: z.string().optional(),
  environment: z.string().optional(),
  format: z.enum(['markdown', 'json']).optional(),
  snapshotDir: z.string().optional(),
  aiKey: z.string().optional(),
  autonomy: z.object({ level: z.enum(['observe', 'enforce']) }).optional(),
  auth: FlatAuthSchema.optional(),
  // #560: Ad-hoc scan support — endpoint + protocol in .dino.yml
  endpoint: z.url().optional(),
  protocol: z.enum(['graphql', 'rest']).optional(),
  // #2140: REST ad-hoc scans have no introspection — point at an OpenAPI spec
  // (URL or local file path). Required when protocol is 'rest'.
  specUrl: z.string().min(1).optional(),
});

export interface LoadCliConfigOptions {
  /** When set, config.tenant must match or be unset (Batch 10+11, #413). */
  tenantId?: string | undefined;
}

/** #2160/#2161: flat-config auth arms (none | header | oauth2 | legacy tenant-rbac). */
export type FlatAuthConfig =
  | { type: 'none' }
  | {
      type: 'header';
      header: string;
      scheme?: string | undefined;
      valueEnv: string;
    }
  | {
      type: 'oauth2';
      tokenEndpoint: string;
      clientIdEnv: string;
      clientSecretEnv: string;
      scope?: string | undefined;
    }
  | {
      enabled: boolean;
      role?: string | undefined;
    };

export interface DinoCliConfig {
  /** Default tenant ID */
  tenant?: string | undefined;
  /** Default environment */
  environment?: string | undefined;
  /** Default output format */
  format?: ('markdown' | 'json') | undefined;
  /** Snapshot directory override */
  snapshotDir?: string | undefined;
  /** AI key for reasoning (or set DINO_AI_KEY when running scan). */
  aiKey?: string | undefined;
  /** Shadow Mode autonomy config */
  autonomy?:
    | {
        level: 'observe' | 'enforce';
      }
    | undefined;
  /** Auth configuration: none | header-token | oauth2 | legacy {enabled,role} (#2160/#2161) */
  auth?: FlatAuthConfig | undefined;
  /** Direct API endpoint URL for ad-hoc scans (#560) */
  endpoint?: string | undefined;
  /** API protocol for ad-hoc scans - graphql (introspection) or rest (OpenAPI). #560/#2140 */
  protocol?: 'graphql' | 'rest' | undefined;
  /** OpenAPI spec URL or file path - required when protocol is 'rest' (#2140). */
  specUrl?: string | undefined;
}

const DINO_CONFIG_SEARCH_PLACES = [
  'package.json',
  '.dino.yml',
  '.dino.yaml',
  '.dinorc',
  '.dinorc.json',
  '.dinorc.yaml',
  '.dinorc.yml',
] as const;

/**
 * #2210 (completes D5): cosmiconfig throws an UNTYPED Error on a YAML syntax error;
 * classify it as a config problem (exit 5), not a Dino crash (70). Bound the FINAL message
 * (single-line, ≤200) so a large/multiline malformed file cannot dump. NOTE: slice the
 * *composed* string, not the raw text — else the "Invalid .dino.yml: " prefix pushes it >200.
 */
function throwYamlParseCliError(err: unknown): never {
  const raw = (err instanceof Error ? err.message : String(err)).replaceAll(/\s+/g, ' ').trim();
  const message = `Invalid .dino.yml: ${raw}`.slice(0, 200);
  throw new CliError(
    message,
    5,
    'Fix the YAML syntax in .dino.yml (check indentation/quotes/brackets), or run dino init to regenerate it.',
    err,
    'config',
  );
}

function assertTenantMatchesFlag(
  options: LoadCliConfigOptions | undefined,
  tenant: string | undefined,
): void {
  if (options?.tenantId != null && tenant != null && options.tenantId !== tenant) {
    throw new CliError(
      `Config tenant "${tenant}" does not match requested tenant "${options.tenantId}".`,
      2,
      `Use --tenant ${tenant}, or set the matching tenant in .dino.yml.`,
      undefined,
      'usage',
    );
  }
}

function stripAiKeyOutsideCwd(
  filepath: string | undefined,
  aiKey: string | undefined,
): string | undefined {
  if (!filepath) return aiKey;
  const configDir = path.dirname(filepath);
  const rel = path.relative(process.cwd(), configDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  return aiKey;
}

/**
 * Search for non-executable config from cwd upward.
 * Only YAML/JSON are allowed; dino.config.js and other executable files are excluded (#450).
 * Returns null if no config found (all values come from flags).
 *
 * Batch 10+11 (#413): options.tenantId validates config.tenant; aiKey stripped when config file is outside cwd.
 */
export async function loadCliConfig(options?: LoadCliConfigOptions): Promise<DinoCliConfig | null> {
  const explorer = cosmiconfig('dino', {
    searchPlaces: [...DINO_CONFIG_SEARCH_PLACES],
  });
  let result;
  try {
    result = await explorer.search();
  } catch (err) {
    throwYamlParseCliError(err);
  }
  if (!result?.config) return null;

  // B99 (#668): Validate config shape with Zod before using
  const parsed = DinoCliConfigSchema.safeParse(result.config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new CliError(
      `Invalid .dino.yml config: ${issues}`,
      5,
      'Fix the reported field(s) in .dino.yml, or run dino init to regenerate it.',
      parsed.error,
      'config',
    );
  }
  const config = parsed.data;
  const tenant = config.tenant;
  assertTenantMatchesFlag(options, tenant);

  return {
    tenant,
    environment: config.environment,
    format: config.format,
    snapshotDir: config.snapshotDir,
    aiKey: stripAiKeyOutsideCwd(result.filepath, config.aiKey),
    autonomy: config.autonomy,
    // #2160: pass the auth union through verbatim (drop enabled-only narrowing)
    auth: config.auth,
    endpoint: config.endpoint,
    protocol: config.protocol,
    specUrl: config.specUrl,
  };
}
