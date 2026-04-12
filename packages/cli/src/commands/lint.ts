/**
 * @dino/cli — dino lint (schema description audit vs last snapshot).
 * Spec: docs/CLI_SPEC.md §5.5
 */

import type { CommandContext, CommonFlags } from '../shared/base-command';
import { discoverOperations, withTracking } from '../shared/base-command';
import { buildSnapshot, saveSnapshot, loadLatestSnapshot, auditDescriptions } from '@intelligence';
import { safePath } from '@utils/safe-path';
import { renderLintMarkdown } from '../formatters/markdown';
import { renderLintJson } from '../formatters/json';
import { detectUi, createSpinner } from '../shared/ui';
import { shouldRenderInkView } from '../ink/render';
import { CLI_VERSION } from '../version';

export interface LintFlags extends CommonFlags {
  snapshotDir?: string;
  failOnUndocumented?: boolean;
}

const DEFAULT_SNAPSHOT_DIR = '.dino/snapshots';

/**
 * dino lint --tenant acme --env qa [--fail-on-undocumented]
 */
export async function runLint(context: CommandContext, flags: LintFlags): Promise<number> {
  return withTracking(
    context,
    'lint',
    {
      tenant: flags.tenant,
      env: flags.env,
      snapshotDir: flags.snapshotDir,
      failOnUndocumented: flags.failOnUndocumented,
      debug: flags.debug,
      noColor: flags.noColor,
    },
    flags.quiet,
    async () => {
      const ui = detectUi({ quiet: flags.quiet, noColor: flags.noColor });
      const spinner = createSpinner('Auditing schema descriptions…', ui);
      spinner.start();
      let graphqlOps;
      try {
        graphqlOps = await discoverOperations(context);
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
      const audit = auditDescriptions(graphqlOps, previousSnapshot);

      const currentSnapshot = buildSnapshot(graphqlOps, context.tenantId, context.environment);
      await saveSnapshot(currentSnapshot, snapshotOptions);

      spinner.succeed('Audit complete');

      const format = flags.format ?? 'markdown';
      const markdownUi = format === 'json' ? undefined : ui;
      const output =
        format === 'json' ? renderLintJson(audit) : renderLintMarkdown(audit, markdownUi);
      if (!flags.quiet) console.info(output);

      if (!flags.quiet && shouldRenderInkView(ui, { format, quiet: flags.quiet })) {
        try {
          const React = await import('react');
          const { renderViewSafe } = await import('../ink/render');
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

      const regressions = audit.newUndocumented.length + audit.descriptionRemoved.length;
      return flags.failOnUndocumented && regressions > 0 ? 1 : 0;
    },
  );
}
