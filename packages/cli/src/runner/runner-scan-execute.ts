/**
 * Single scan assignment execution body for `createRunnerExecuteScan` (#1150, #1759 B3b).
 */

import { createRestExecutor } from '@dino/agents';
import { createTracker, createNoopAdapter } from '@dino/analytics';
import {
  buildRunnerDcgPayload,
  buildSnapshot,
  type ToolName,
  type PipelineOptions,
  type runPipeline,
  type Timer,
} from '@dino/engine';
import { startCancelWatch } from './cancel-watch';
import { createScanLogEmitter } from './log-emitter';
import { resolveRunnerRestSpec } from './runner-rest-spec';
import { wireRunnerScanAuth } from './runner-scan-auth-wiring';
import { buildAdHocRegistry } from '../commands/scan';
import { discoverOperationsDetailed } from '../shared/base-command';
import { createExecutor, VALID_TOOL_NAMES } from '../shared/pipeline-helpers';
import { CLI_VERSION } from '../version';
import type { RunnerRbacWire } from './runner-scan-auth-wiring';
import type { AcquiredScanAuth } from './scan-auth';
import type { RunnerState } from './state-store';
import type { CommandContext } from '../shared/base-command';
import type { GraphQLOperation, RunnerJob, RunnerResult } from '@dino/core';

type ScanExecuteDeps = {
  state: RunnerState;
  assignment: RunnerJob;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  /** Cloud-facing HTTP for the log emitter + cancel watch (NOT the #1850 pinned customer fetch). */
  cloudHttpClient: (url: string, init?: RequestInit) => Promise<Response>;
  timer: Timer;
  buildPipelineOptions: (args: {
    state: RunnerState;
    assignment: RunnerJob;
    registry: Record<string, string[]>;
    executor: PipelineOptions['executor'];
    effectiveTools: ToolName[];
    tracker: NonNullable<PipelineOptions['tracker']>;
    hasRest: boolean;
    restExecutor: PipelineOptions['restExecutor'];
    restOps: PipelineOptions['restOperations'];
    discoveryRaw: unknown;
    rbacRoles?: PipelineOptions['rbacRoles'];
    rbacExpectations?: PipelineOptions['rbacExpectations'];
    rbacDefaultExpectations?: PipelineOptions['rbacDefaultExpectations'];
    tokenResolver?: PipelineOptions['tokenResolver'];
    rbacRestExecutor?: PipelineOptions['rbacRestExecutor'];
    rbacDefaultProbeMode?: PipelineOptions['rbacDefaultProbeMode'];
    logger?: PipelineOptions['logger'];
    onToolEvent?: PipelineOptions['onToolEvent'];
    abortSignal?: PipelineOptions['abortSignal'];
  }) => PipelineOptions;
  buildTenantConfig: (
    tenantId: string,
    targetUrl: string,
    rest?: { source: string; specPath: string },
  ) => CommandContext['tenantConfig'];
};

/**
 * @internal Exported for unit tests (sweep R4). Mirror of shared `withAuth` for the pool runner:
 * inject the acquired scan bearer token into the GraphQL executor on each call, reflecting any
 * REST-triggered refresh via the shared `getAuth` closure. A caller-supplied `authToken` wins; a
 * failed/absent acquisition injects no token (never a fabricated bearer).
 */
export function withRunnerScanAuth(
  executor: PipelineOptions['executor'],
  getAuth: () => AcquiredScanAuth,
): PipelineOptions['executor'] {
  return async (document, variables, options) => {
    const auth = getAuth();
    const token = options?.authToken ?? (auth.authFailed ? undefined : auth.authToken);
    // #1981 — non-bearer auth (api_key / basic_auth / cookie- or header-based login_flow) is carried
    // ONLY by `injections` / `cookieHeader`. R4 threaded the bearer token but dropped these, so those
    // profiles authenticated successfully and then scanned unauthenticated — a silent false-CLEAN.
    // A failed acquisition contributes nothing (never a fabricated credential), matching the token rule.
    const injections = auth.authFailed ? undefined : auth.injections;
    const cookieHeader = auth.authFailed ? undefined : auth.cookieHeader;
    return executor(document, variables, {
      ...options,
      ...(token === undefined ? {} : { authToken: token }),
      ...(injections === undefined || injections.length === 0 ? {} : { injections }),
      ...(cookieHeader === undefined || cookieHeader === '' ? {} : { cookieHeader }),
    });
  };
}

/** @internal Exported for unit tests (#2124). */
export function resolveBaseEffectiveTools(agentSet?: string[]): ToolName[] {
  const base = [...VALID_TOOL_NAMES].filter((t) => t !== 'rbac-matrix') as ToolName[];
  if (agentSet === undefined || agentSet.length === 0) {
    return base;
  }
  const dropped: string[] = [];
  const allowed = new Set(
    agentSet.filter((name) => {
      if (VALID_TOOL_NAMES.has(name)) {
        return true;
      }
      dropped.push(name);
      return false;
    }),
  );
  if (dropped.length > 0) {
    console.warn(JSON.stringify({ message: 'runner_agent_set_unknown_dropped', dropped }));
  }
  if (allowed.size === 0) {
    return base;
  }
  return base.filter((name) => allowed.has(name));
}

/** @internal Exported for unit tests (#2124). */
export function agentSetAllowsRbac(agentSet?: string[]): boolean {
  if (agentSet === undefined || agentSet.length === 0) {
    return true;
  }
  return agentSet.some((name) => name === 'rbac-matrix' && VALID_TOOL_NAMES.has(name));
}

/** @internal Exported for #2087 integration tests. */
export async function prepareRunnerScanContext(deps: ScanExecuteDeps) {
  const { state, assignment } = deps;
  const restSpec = await resolveRunnerRestSpec(assignment, {
    fetchImpl: deps.fetchImpl,
    logger: {
      info(msg, data) {
        console.info(JSON.stringify(data ? { event: msg, ...data } : { event: msg }));
      },
      error(msg, data) {
        console.error(JSON.stringify(data ? { event: msg, ...data } : { event: msg }));
      },
    },
  });
  try {
    const tenantConfig = deps.buildTenantConfig(
      state.tenantId,
      assignment.targetUrl,
      restSpec.restConfig,
    );
    const tracker = createTracker({ adapter: createNoopAdapter(), tenantId: state.tenantId });
    const context: CommandContext = {
      tenantConfig,
      tenantId: state.tenantId,
      environment: 'cloud',
      tracker,
    };
    const discoveryMeta = await discoverOperationsDetailed(context);
    const registry = buildAdHocRegistry(discoveryMeta.graphqlOperations, state.tenantId);
    // #1850 — the pool runner hits customer-controlled targets; pass the (pinned in prod) fetchImpl so the
    // GraphQL executor's connection is pinned to the validated IP. In tests deps.fetchImpl is the injected mock.
    const executor = createExecutor(assignment.targetUrl, deps.fetchImpl);
    const effectiveTools = resolveBaseEffectiveTools(assignment.agentSet);
    const restOps = discoveryMeta.discoveredOperations.filter((op) => op.type === 'rest');
    const hasRest = restOps.length > 0;
    return { tracker, registry, executor, effectiveTools, restOps, hasRest, discoveryMeta };
  } finally {
    await restSpec.cleanup();
  }
}

type ResolvedRestExecutor =
  | { ok: false; error: 'auth_failed' }
  | {
      ok: true;
      restExecutor: PipelineOptions['restExecutor'];
      rbacRestExecutor?: PipelineOptions['rbacRestExecutor'];
      authConfigured: boolean;
      rbacDeclared?: boolean;
      getAuth?: () => AcquiredScanAuth;
      authLost: () => boolean;
      rotatedRefreshToken: () => string | undefined;
      rbac?: RunnerRbacWire;
    };

async function resolveRestExecutor(
  deps: ScanExecuteDeps,
  hasRest: boolean,
): Promise<ResolvedRestExecutor> {
  const baseRestExecutor = hasRest ? createRestExecutor({ fetch: deps.fetchImpl }) : undefined;
  const authWire = await wireRunnerScanAuth({
    state: deps.state,
    assignment: deps.assignment,
    baseRestExecutor,
    hasRest,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    sleep: deps.sleep,
    rand: deps.rand,
  });
  if (!authWire.ok) {
    return { ok: false, error: 'auth_failed' };
  }
  return {
    ok: true,
    restExecutor: authWire.restExecutor,
    authConfigured: authWire.authConfigured,
    ...(authWire.getAuth === undefined ? {} : { getAuth: authWire.getAuth }),
    authLost: authWire.authLost,
    rotatedRefreshToken: authWire.rotatedRefreshToken,
    ...(authWire.rbacDeclared === undefined ? {} : { rbacDeclared: authWire.rbacDeclared }),
    ...(baseRestExecutor === undefined ? {} : { rbacRestExecutor: baseRestExecutor }),
    ...(authWire.rbac === undefined ? {} : { rbac: authWire.rbac }),
  };
}

/** @internal Exported for unit tests (#1871 gating). */
export function rbacPipelineFields(
  restWire: Extract<ResolvedRestExecutor, { ok: true }>,
  hasProbeTargets: boolean,
): {
  effectiveTools: ToolName[];
  rbacRoles?: PipelineOptions['rbacRoles'];
  rbacExpectations?: PipelineOptions['rbacExpectations'];
  rbacDefaultExpectations?: PipelineOptions['rbacDefaultExpectations'];
  tokenResolver?: PipelineOptions['tokenResolver'];
  rbacDefaultProbeMode?: PipelineOptions['rbacDefaultProbeMode'];
} {
  const rbac = restWire.rbac;
  const configuredRbac = rbac !== undefined && rbac.rbacRoles.length > 0;

  if (restWire.rbacDeclared === true && !configuredRbac) {
    // #1873 — declared but wire empty/invalid: keep rbac-matrix in with empty roles so the
    // agent surfaces notTested → UNTESTED (never drop the tool → false CLEAN on auth).
    return {
      effectiveTools: ['rbac-matrix'],
      rbacRoles: [],
      tokenResolver: async () => null,
      rbacDefaultProbeMode: false,
    };
  }

  if (configuredRbac && rbac !== undefined) {
    return {
      effectiveTools: ['rbac-matrix'],
      rbacRoles: rbac.rbacRoles,
      rbacExpectations: rbac.rbacExpectations,
      rbacDefaultExpectations: rbac.rbacDefaultExpectations,
      tokenResolver: rbac.tokenResolver,
      rbacDefaultProbeMode: false,
    };
  }

  if (restWire.authConfigured && hasProbeTargets) {
    return {
      effectiveTools: ['rbac-matrix'],
      rbacRoles: ['UNAUTHENTICATED'],
      tokenResolver: async () => null,
      rbacDefaultProbeMode: true,
    };
  }

  return { effectiveTools: [] as ToolName[] };
}

function buildCompletedRunnerResult(opts: {
  assignment: RunnerJob;
  result: Awaited<ReturnType<typeof runPipeline>>;
  restWire: Extract<ResolvedRestExecutor, { ok: true }>;
  cancelObserved: boolean;
  schemaSnapshot?: unknown;
}): RunnerResult {
  const { assignment, result, restWire, cancelObserved, schemaSnapshot } = opts;
  // Terminal cancel (Spec B INV-4): ONLY when the cloud's cancelRequested flag was actually
  // observed AND the pipeline abort path ran — never fabricated from an abort alone.
  if (cancelObserved && result.metadata.cancelled) {
    const rotated = restWire.rotatedRefreshToken();
    return {
      scanId: assignment.scanId,
      status: 'cancelled',
      toolsCompletedCount: result.metadata.toolsCompleted.length,
      ...(rotated === undefined ? {} : { rotatedRefreshToken: rotated }),
    };
  }

  if (restWire.authLost()) {
    const rotated = restWire.rotatedRefreshToken();
    return {
      scanId: assignment.scanId,
      status: 'failed',
      error: 'auth_lost',
      failureType: 'auth_lost',
      ...(rotated === undefined ? {} : { rotatedRefreshToken: rotated }),
    };
  }

  const rotated = restWire.rotatedRefreshToken();
  return {
    scanId: assignment.scanId,
    status: 'completed',
    dcg: buildRunnerDcgPayload(result.condensed, CLI_VERSION),
    attestation: result.attestation,
    result,
    ...(rotated === undefined ? {} : { rotatedRefreshToken: rotated }),
    ...(schemaSnapshot === undefined ? {} : { schemaSnapshot }),
  };
}

/** Build a SchemaSnapshot when GraphQL ops exist; omit for REST-only (#2110). */
export function buildRunnerSchemaSnapshot(opts: {
  graphqlOperations: readonly GraphQLOperation[];
  tenantId: string;
}): unknown | undefined {
  if (opts.graphqlOperations.length === 0) {
    return undefined;
  }
  try {
    return buildSnapshot({
      introspection: opts.graphqlOperations,
      tenantId: opts.tenantId,
      environment: 'cloud',
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        message: 'runner_schema_snapshot_build_failed',
        tenant_id: opts.tenantId,
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
    return undefined;
  }
}

type LiveScanWires = {
  emitter: ReturnType<typeof createScanLogEmitter>;
  watch: { stop: () => void };
  signal: AbortSignal;
  cancelObserved: () => boolean;
};

/**
 * Live emission + cancel observation (Spec B). Both are best-effort and NEVER fail the scan
 * (INV-1); the abort controller is fired ONLY by an observed cloud cancel flag (INV-4).
 */
function startLiveScanWires(opts: ScanExecuteDeps): LiveScanWires {
  const controller = new AbortController();
  let cancelObserved = false;
  const common = {
    cloudEndpoint: opts.state.cloudEndpoint,
    runnerToken: opts.state.token,
    capabilityToken: opts.assignment.capabilityToken,
    scanId: opts.assignment.scanId,
    httpClient: opts.cloudHttpClient,
    timer: opts.timer,
  };
  const emitter = createScanLogEmitter(common);
  const watch = startCancelWatch({
    ...common,
    onCancel: () => {
      cancelObserved = true;
      controller.abort();
    },
  });
  return { emitter, watch, signal: controller.signal, cancelObserved: () => cancelObserved };
}

type PreparedScanContext = Awaited<ReturnType<typeof prepareRunnerScanContext>>;

/** Assemble the buildPipelineOptions args (kept out of executeRunnerAssignment for the line cap). */
function assemblePipelineArgs(
  opts: ScanExecuteDeps,
  prepared: PreparedScanContext,
  restWire: Extract<ResolvedRestExecutor, { ok: true }>,
  wires: LiveScanWires,
): Parameters<ScanExecuteDeps['buildPipelineOptions']>[0] {
  const hasProbeTargets =
    prepared.restOps.length > 0 || Object.values(prepared.registry).some((ops) => ops.length > 0);
  const rbacFields = agentSetAllowsRbac(opts.assignment.agentSet)
    ? rbacPipelineFields(restWire, hasProbeTargets)
    : { effectiveTools: [] as ToolName[] };
  const effectiveTools =
    rbacFields.effectiveTools.length > 0
      ? ([...prepared.effectiveTools, ...rbacFields.effectiveTools] as ToolName[])
      : prepared.effectiveTools;
  // R4 — thread the acquired scan bearer token into the GraphQL executor (parity with REST + the
  // interactive path's `withAuth`); without this, GraphQL ops scan unauthenticated → false-clean.
  const authedExecutor = withRunnerScanAuth(
    prepared.executor,
    restWire.getAuth ?? (() => ({ authFailed: false })),
  );
  return {
    state: opts.state,
    assignment: opts.assignment,
    registry: prepared.registry,
    executor: authedExecutor,
    effectiveTools,
    tracker: prepared.tracker,
    hasRest: prepared.hasRest,
    restExecutor: restWire.restExecutor,
    ...(restWire.rbacRestExecutor === undefined
      ? {}
      : { rbacRestExecutor: restWire.rbacRestExecutor }),
    restOps: prepared.restOps,
    discoveryRaw: prepared.discoveryMeta.discoveryRaw,
    ...(rbacFields.rbacRoles === undefined
      ? {}
      : {
          rbacRoles: rbacFields.rbacRoles,
          rbacExpectations: rbacFields.rbacExpectations,
          rbacDefaultExpectations: rbacFields.rbacDefaultExpectations,
          tokenResolver: rbacFields.tokenResolver,
          ...(rbacFields.rbacDefaultProbeMode === undefined
            ? {}
            : { rbacDefaultProbeMode: rbacFields.rbacDefaultProbeMode }),
        }),
    logger: wires.emitter.pipelineLogger(),
    onToolEvent: wires.emitter.onToolEvent,
    abortSignal: wires.signal,
  };
}

export async function executeRunnerAssignment(
  opts: ScanExecuteDeps & { pipelineRunner: typeof runPipeline },
): Promise<RunnerResult> {
  const { assignment, pipelineRunner } = opts;
  const prepared = await prepareRunnerScanContext(opts);
  const restWire = await resolveRestExecutor(opts, prepared.hasRest);
  if (!restWire.ok) {
    return {
      scanId: assignment.scanId,
      status: 'failed',
      error: 'auth_failed',
      failureType: 'auth_failed',
    };
  }

  const wires = startLiveScanWires(opts);

  try {
    const result = await pipelineRunner(
      opts.buildPipelineOptions(assemblePipelineArgs(opts, prepared, restWire, wires)),
    );

    const schemaSnapshot = buildRunnerSchemaSnapshot({
      graphqlOperations: prepared.discoveryMeta.graphqlOperations,
      tenantId: opts.state.tenantId,
    });
    return buildCompletedRunnerResult({
      assignment,
      result,
      restWire,
      cancelObserved: wires.cancelObserved(),
      schemaSnapshot,
    });
  } finally {
    wires.watch.stop();
    await wires.emitter.stop();
  }
}
