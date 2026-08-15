/**
 * @dino/cli — dino lint (schema description audit vs last snapshot).
 * Spec: docs/CLI_SPEC.md §5.5
 */

import {
  buildSnapshot,
  saveSnapshot,
  loadLatestSnapshot,
  auditDescriptions,
  safePath,
} from '@dino/engine';
import { renderLintJson } from '../formatters/json';
import { renderLintMarkdown } from '../formatters/markdown';
import { shouldRenderInkView } from '../ink/InkRender';
import { discoverOperationsDetailed, withTracking } from '../shared/base-command';
import { emitResult } from '../shared/emit-result';
import { detectUi, createSpinner } from '../shared/ui';
import { CLI_VERSION } from '../version';
import type { CommandContext, CommonFlags } from '../shared/base-command';

export interface LintFlags extends CommonFlags {
  snapshotDir?: string;
  failOnUndocumented?: boolean;
}

const DEFAULT_SNAPSHOT_DIR = '.dino/snapshots';

async function tryRenderLintInkView(
  audit: ReturnType<typeof auditDescriptions>,
  context: CommandContext,
  ui: ReturnType<typeof detectUi>,
): Promise<void> {
  try {
    const React = await import('react');
    const { renderViewSafe } = await import('../ink/InkRender');
    const { LintView } = await import('../views/LintView');
    const findings = [
      ...audit.newUndocumented.slice(0, 12).map((name) => ({
        severity: 'MEDIUM',
        message: 'New undocumented operation',
        operation: name,
      })),
      ...audit.descriptionRemoved.slice(0, 12).map((name) => ({
        severity: 'HIGH',
        message: 'Description removed',
        operation: name,
      })),
    ];
    renderViewSafe(
      React.createElement(LintView, {
        version: CLI_VERSION,
        tenant: context.tenantId,
        environment: context.environment,
        totalOperations: audit.totalOperations,
        documentedPercent: audit.coveragePercent,
        regressionCount: audit.newUndocumented.length + audit.descriptionRemoved.length,
        findings,
        colored: ui.colored,
      }),
    );
  } catch (inkErr) {
    console.warn(
      '[dino] Ink lint view failed:',
      inkErr instanceof Error ? inkErr.message : String(inkErr),
    );
  }
}

async function executeLintBody(context: CommandContext, flags: LintFlags): Promise<number> {
  const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
  const spinner = createSpinner('Auditing schema descriptions…', ui);
  spinner.start();
  let graphqlOps;
  let restOperations;
  try {
    const detailed = await discoverOperationsDetailed(context);
    graphqlOps = detailed.graphqlOperations;
    restOperations = detailed.discoveredOperations.filter((o) => o.type === 'rest');
    spinner.text = 'Auditing descriptions…';
  } catch (err) {
    spinner.fail('Audit failed');
    throw err;
  }

  const snapshotDir = flags.snapshotDir ? safePath(flags.snapshotDir) : DEFAULT_SNAPSHOT_DIR;
  const snapshotOptions = {
    snapshotDir,
    tenantId: context.tenantId,
    environment: context.environment,
  };

  const previousSnapshot = await loadLatestSnapshot(snapshotOptions);
  const audit = auditDescriptions([...graphqlOps, ...restOperations], previousSnapshot);

  const currentSnapshot = buildSnapshot({
    introspection: graphqlOps,
    restOperations,
    tenantId: context.tenantId,
    environment: context.environment,
  });
  await saveSnapshot(currentSnapshot, snapshotOptions);

  spinner.succeed('Audit complete');

  const format = flags.format ?? 'markdown';
  const markdownUi = format === 'json' ? undefined : ui;
  const output = format === 'json' ? renderLintJson(audit) : renderLintMarkdown(audit, markdownUi);
  // #172: --quiet strips chrome only — the audit report always goes to stdout via emitResult (#2172)
  emitResult(output, { format: format === 'json' ? 'json' : 'markdown' });

  if (!flags.quiet && shouldRenderInkView(ui, { format, quiet: flags.quiet })) {
    await tryRenderLintInkView(audit, context, ui);
  }

  const regressions = audit.newUndocumented.length + audit.descriptionRemoved.length;
  return flags.failOnUndocumented && regressions > 0 ? 3 : 0;
}

/**
 * dino lint --tenant acme --env qa [--fail-on-undocumented]
 */
export async function runLint(context: CommandContext, flags: LintFlags): Promise<number> {
  return withTracking({
    context,
    command: 'lint',
    flagsPayload: {
      tenant: flags.tenant,
      env: flags.env,
      snapshotDir: flags.snapshotDir,
      failOnUndocumented: flags.failOnUndocumented,
      debug: flags.debug,
      noColor: flags.noColor,
    },
    quiet: flags.quiet,
    body: () => executeLintBody(context, flags),
  });
}
