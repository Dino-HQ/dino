/**
 * The repository file `--format sarif` attaches findings to (#2177). GitHub code scanning only displays a
 * result that points at a file in the repository, and a result whose path changes between runs becomes a
 * new alert, so the anchor is chosen by a fixed order and must be a file git tracks in the workspace. Nothing is
 * fabricated: with no such file the scan is refused before any request is sent.
 */
import path from 'node:path';
import { CliError } from './errors';

export interface SarifAnchorInputs {
  /** OpenAPI spec path or URL for a REST target (a URL is never an anchor). */
  specPath?: string | undefined;
  /** GraphQL SDL path, relative to the tenant config directory. */
  schemaPath?: string | undefined;
  tenantConfigDir?: string | undefined;
  /** The `.dino.yml` that was loaded (absolute). */
  configPath?: string | undefined;
  /** `GITHUB_WORKFLOW_REF`: `owner/repo/.github/workflows/scan.yml@refs/heads/main`. */
  workflowRef?: string | undefined;
  /** `GITHUB_WORKSPACE`, else the current directory. */
  workspace: string;
  cwd: string;
  /** True only for a file git tracks in the workspace repository (an untracked or ignored file is no anchor). */
  isTracked: (absolutePath: string) => boolean;
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

function workflowFile(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const at = ref.lastIndexOf('@');
  const withoutRef = at === -1 ? ref : ref.slice(0, at);
  const parts = withoutRef.split('/');
  return parts.length > 2 ? parts.slice(2).join('/') : undefined;
}

function candidates(i: SarifAnchorInputs): string[] {
  const out: string[] = [];
  if (i.specPath !== undefined && i.specPath !== '' && !URL_LIKE.test(i.specPath)) out.push(path.resolve(i.cwd, i.specPath));
  if (i.schemaPath !== undefined && i.schemaPath !== '') out.push(path.resolve(i.tenantConfigDir ?? i.cwd, i.schemaPath));
  if (i.configPath !== undefined) out.push(path.resolve(i.configPath));
  const workflow = workflowFile(i.workflowRef);
  if (workflow !== undefined) out.push(path.resolve(i.workspace, workflow));
  return out;
}

/** The first candidate git tracks inside the workspace, as a repository-relative path with `/`. */
export function resolveSarifAnchor(i: SarifAnchorInputs): string | undefined {
  const workspace = path.resolve(i.workspace);
  for (const absolute of candidates(i)) {
    const relative = path.relative(workspace, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!i.isTracked(absolute)) continue;
    return relative.split(path.sep).join('/');
  }
  return undefined;
}

export function requireSarifAnchor(i: SarifAnchorInputs): string {
  const anchor = resolveSarifAnchor(i);
  if (anchor !== undefined) return anchor;
  throw new CliError(
    '--format sarif needs a file in this repository to attach findings to, and none was found.',
    2,
    'Scan with a local OpenAPI spec or SDL file, add a .dino.yml to the repository, or run inside GitHub Actions.',
    undefined,
    'usage',
  );
}
