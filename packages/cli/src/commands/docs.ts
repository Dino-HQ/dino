/**
 * @dino/cli — dino docs (API reference from catalog, no pipeline).
 * Spec: docs/CLI_SPEC.md §5.2
 */

import { safeWriteFile } from '@dino/core';
import {
  getAllOperations,
  hasOperationsFile,
  buildCatalog,
  renderCatalogMarkdown,
  renderCatalogJson,
} from '@dino/engine';
import { buildAdHocOperationMappings } from './scan-helpers';
import { discoverOperationsDetailed, withTracking } from '../shared/base-command';
import { emitResult } from '../shared/emit-result';
import { neutralizeCatalogCustomerFields } from '../shared/neutralize';
import { safeUserPath } from '../shared/safe-user-path';
import { detectUi, createSpinner, printNotice } from '../shared/ui';
import type { CommandContext, CommonFlags } from '../shared/base-command';

export interface DocsFlags extends CommonFlags {
  output?: string;
  title?: string;
  /** Deprecated no-op: the CLI runs no AI. Accepted with a notice; removed in the next major version. */
  ai?: boolean;
  threshold?: number;
}

/** #2306 - discovery provenance so SDL-sourced docs are never presented as live-full. */
interface DocsProvenance {
  introspectionLevel?: 'full' | 'shallow' | 'minimal' | undefined;
  structureSource?: 'live' | 'sdl' | undefined;
}

function formatCatalogOutput(
  catalog: ReturnType<typeof buildCatalog>,
  flags: DocsFlags,
  provenance: DocsProvenance,
): string {
  const format = flags.format ?? 'markdown';
  const ctx = format === 'json' ? 'json' : 'markdown';
  const safeCatalog = catalog.map((entry) => neutralizeCatalogCustomerFields(entry, ctx));
  if (format === 'json') {
    return JSON.stringify(
      renderCatalogJson(safeCatalog, {
        title: flags.title,
        healthScoreThreshold: flags.threshold,
        introspectionLevel: provenance.introspectionLevel,
        structureSource: provenance.structureSource,
      }),
      null,
      2,
    );
  }
  return renderCatalogMarkdown(safeCatalog, {
    title: flags.title ?? 'API Intelligence Report',
    healthScoreThreshold: flags.threshold,
    introspectionLevel: provenance.introspectionLevel,
    structureSource: provenance.structureSource,
  });
}

async function executeDocsBody(context: CommandContext, flags: DocsFlags): Promise<number> {
  const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  if (flags.ai) {
    // Reasoning moved to the cloud; the CLI produces no AI descriptions. Accepted so existing
    // scripts keep working; removed in the next major version.
    printNotice('--ai has no effect and will be removed in a future major version: the CLI runs no AI.', ui);
  }
  const spinner = createSpinner('Generating documentation…', ui);
  spinner.start();
  let graphqlOps;
  let restOperations;
  let provenance: DocsProvenance;
  try {
    const detailed = await discoverOperationsDetailed(context);
    graphqlOps = detailed.graphqlOperations;
    restOperations = detailed.discoveredOperations.filter((op) => op.type === 'rest');
    provenance = {
      introspectionLevel: detailed.introspectionLevel,
      structureSource: detailed.structureSource,
    };
    spinner.text = 'Building documentation…';
  } catch (err) {
    spinner.fail('Docs failed');
    throw err;
  }

  // #1986 — mirror scan-pipeline's ad-hoc fallback. `docs` unconditionally read the tenant
  // operations file, so an ad-hoc run (tenant `adhoc`, registry built from live introspection —
  // there is no such file) died with "Tenant operations file not found: …/adhoc-operations.json".
  // Found by runtime verification: `dino scan` worked while `dino docs` still failed.
  const useAdHocFallback = context.tenantId === 'adhoc' || !hasOperationsFile(context.tenantId);
  const catalog = buildCatalog({
    introspection: graphqlOps,
    restOperations,
    registry: useAdHocFallback
      ? buildAdHocOperationMappings(graphqlOps, context.tenantId)
      : getAllOperations(context.tenantId),
    timestamp: new Date().toISOString(), // determinism:allowed
  });

  const output = formatCatalogOutput(catalog, flags, provenance);
  spinner.succeed('Docs generated');

  if (flags.output) {
    const resolvedOutput = safeUserPath(flags.output, '--output');
    await safeWriteFile(resolvedOutput, output, process.cwd());
  } else {
    // #172: --quiet strips chrome only — the report always goes to stdout via emitResult (#2172)
    emitResult(output, { format: flags.format === 'json' ? 'json' : 'markdown' });
  }

  return 0;
}

/**
 * dino docs --tenant acme --env qa [--format json] [--output ./docs/api.md]
 */
export async function runDocs(context: CommandContext, flags: DocsFlags): Promise<number> {
  return withTracking({
    context,
    command: 'docs',
    flagsPayload: {
      tenant: flags.tenant,
      env: flags.env,
      format: flags.format,
      output: flags.output,
      title: flags.title,
      ai: flags.ai,
      threshold: flags.threshold,
      debug: flags.debug,
      noColor: flags.noColor,
    },
    quiet: flags.quiet,
    body: () => executeDocsBody(context, flags),
  });
}
