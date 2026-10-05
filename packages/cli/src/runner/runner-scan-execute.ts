/**
 * Single scan assignment execution body for `createRunnerExecuteScan` (#1150, #1759 B3b).
 */

import { createRestExecutor } from '@dino/agents';
import { createTracker, createNoopAdapter } from '@dino/analytics';
import type { AttestationSigner, ToolName, PipelineOptions, Timer } from '@dino/engine';
import { attestCanonicalResult } from './runner-attestation';
import { buildCompletedRunnerResult, buildRunnerSchemaSnapshot, failedRunnerResult } from './runner-scan-result';
import { startLiveScanWires, type LiveScanWires } from './runner-live-wires';
import { resolveRunnerRestSpec, type RunnerRestSpecResult } from './runner-rest-spec';
import { wireRunnerScanAuth } from './runner-scan-auth-wiring';
import { acquiredCredential, discoveryAuthOf, discoveryFailed, refusedRunnerResult, type DiscoveryAuth } from './runner-discovery-auth';
import { buildAdHocRegistry } from '../commands/scan';
import { discoverOperationsDetailed } from '../shared/base-command';
import { discoveryRead } from '../shared/introspection-level';
import { createExecutor, VALID_TOOL_NAMES } from '../shared/pipeline-helpers';
import { CLI_VERSION } from '../version';
import type { RunnerRbacWire } from './runner-scan-auth-wiring';
import type { AcquiredScanAuth } from './scan-auth';
import type { RunnerState } from './state-store';
import type { ReleaseRefusalCode } from './runner-hydrate';
import type { CommandContext } from '../shared/base-command';
import { ExecutorHttpError, resolveVerificationTarget, type AuthenticationAcquisitionReport, type CredentialNextAction, type DinoResult, type RunnerJob, type RunnerResult, type VerificationTarget, STRICT_DESTINATION } from '@dino/core';

/** The engine boundary the runner drives: options in, the canonical `DinoResult` out (Cleanup V2 task 4c). */
export type PipelineRunner = (options: PipelineOptions) => Promise<DinoResult>;

export type ScanExecuteDeps = {
  state: RunnerState;
  assignment: RunnerJob;
  fetchImpl: typeof fetch;
  /** `null` = no signing identity (tests, unconfigured hosts); `undefined` = resolve at run time. */
  attestationSigner?: AttestationSigner | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  /** Cloud-facing HTTP for the log emitter + cancel watch (NOT the #1850 pinned customer fetch). */
  cloudHttpClient: (url: string, init?: RequestInit) => Promise<Response>;
  timer: Timer;
  buildPipelineOptions: (args: {
    selectedTarget: VerificationTarget;
    state: RunnerState;
    assignment: RunnerJob;
    registry: Record<string, string[]>;
    executor: PipelineOptions['executor'];
    effectiveTools: ToolName[];
    tracker: NonNullable<PipelineOptions['tracker']>;
    hasRest: boolean;
    restExecutor: PipelineOptions['restExecutor'];
    suppliedQueryParams?: PipelineOptions['suppliedQueryParams'];
    restOps: PipelineOptions['restOperations'];
    discoveryRaw: unknown;
    discovery: PipelineOptions['discovery'];
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
  onFinalStatus?: (status: number) => void,
): PipelineOptions['executor'] {
  return async (document, variables, options) => {
    // The anonymous cell is the control every other cell is compared against: it gets none of the
    // acquired credential, in any of its forms.
    if (options?.unauthenticated === true) return executor(document, variables, options);
    const ownContext = options?.authToken === undefined;
    try {
      const response = await executor(document, variables, {
        ...options,
        ...acquiredCredential(getAuth(), options?.authToken),
      });
      // DIN-1492: the Target's answer to a request made with the run's own acquired context. A caller-supplied
      // token (an RBAC role cell) is a designed probe, never a rejection of that context.
      if (ownContext && typeof response.status === 'number') onFinalStatus?.(response.status);
      return response;
    } catch (error) {
      if (ownContext && error instanceof ExecutorHttpError) onFinalStatus?.(error.status);
      throw error;
    }
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

async function runnerRestSpec(deps: ScanExecuteDeps): Promise<RunnerRestSpecResult> {
  return resolveRunnerRestSpec(deps.assignment, {
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
}

/**
 * @internal Exported for #2087 integration tests. DIN-1504: `inputs` carries the spec the caller already resolved and
 * the scan's credential for discovery; without them the spec is resolved here and discovery is unauthenticated.
 */
export async function prepareRunnerScanContext(
  deps: ScanExecuteDeps,
  inputs?: { restSpec?: RunnerRestSpecResult; discoveryAuth?: DiscoveryAuth | undefined },
) {
  const { state, assignment } = deps;
  const restSpec = inputs?.restSpec ?? (await runnerRestSpec(deps));
  try {
    const tenantConfig = deps.buildTenantConfig(
      state.tenantId,
      assignment.targetUrl,
      restSpec.restConfig,
    );
    const tracker = createTracker({ adapter: createNoopAdapter(), tenantId: state.tenantId });
    // A customer-supplied target on the pool runner: admitted under the strict policy, always.
    const selectedTarget = resolveVerificationTarget(
      { url: assignment.targetUrl },
      STRICT_DESTINATION,
    );
    // DIN-1504: discovery runs with the scan's own credential, in header and cookie form; the endpoint stays the Target
    // URL (it is logged), so a query-injected key is not sent to discovery.
    const authHeaders = inputs?.discoveryAuth?.();
    const context: CommandContext = {
      selectedTarget,
      tenantConfig,
      tenantId: state.tenantId,
      environment: 'cloud',
      tracker,
      // The pool runner scans customer-controlled targets: the widened policy can never apply.
      allowPrivateTarget: false,
      ...(authHeaders === undefined || Object.keys(authHeaders).length === 0 ? {} : { authHeaders }),
    };
    let discoveryMeta: Awaited<ReturnType<typeof discoverOperationsDetailed>>;
    try {
      discoveryMeta = await discoverOperationsDetailed(context);
    } catch (error) {
      throw discoveryFailed(error);
    }
    const registry = buildAdHocRegistry(discoveryMeta.graphqlOperations, state.tenantId);
    // #1850 — the pool runner hits customer-controlled targets; pass the (pinned in prod) fetchImpl so the
    // GraphQL executor's connection is pinned to the validated IP. In tests deps.fetchImpl is the injected mock.
    const executor = createExecutor(selectedTarget.url, deps.fetchImpl, {
      // A customer-controlled target on the pool runner: never the operator's widened policy.
      allowPrivateTarget: false,
    });
    const effectiveTools = resolveBaseEffectiveTools(assignment.agentSet);
    const restOps = discoveryMeta.discoveredOperations.filter((op) => op.type === 'rest');
    const hasRest = restOps.length > 0;
    return { tracker, registry, executor, effectiveTools, restOps, hasRest, discoveryMeta, selectedTarget };
  } finally {
    if (inputs?.restSpec === undefined) await restSpec.cleanup();
  }
}

type ResolvedRestExecutor =
  | {
      ok: false;
      error: 'auth_failed';
      credentialCode?: ReleaseRefusalCode;
      credentialNextAction?: CredentialNextAction;
      authentication?: AuthenticationAcquisitionReport;
    }
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
      credentialFailure?: () => ReleaseRefusalCode | undefined;
      authentication?: () => AuthenticationAcquisitionReport | undefined;
      targetResponse?: (status: number) => void;
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
    return authWire;
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
    ...(authWire.credentialFailure === undefined ? {} : { credentialFailure: authWire.credentialFailure }),
    ...(authWire.authentication === undefined ? {} : { authentication: authWire.authentication }),
    ...(authWire.targetResponse === undefined ? {} : { targetResponse: authWire.targetResponse }),
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

/**
 * #2326: the query parameters every REST request of this scan carries. Auth is acquired before the
 * pipeline is assembled, and its query injections are the only query parameters the runner adds.
 */
export function runnerSuppliedQueryParams(getAuth: (() => AcquiredScanAuth) | undefined): string[] {
  return (getAuth?.().injections ?? []).filter((i) => i.target === 'query').map((i) => i.name);
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
    restWire.targetResponse,
  );
  return {
    state: opts.state,
    assignment: opts.assignment,
    selectedTarget: prepared.selectedTarget,
    registry: prepared.registry,
    executor: authedExecutor,
    effectiveTools,
    tracker: prepared.tracker,
    hasRest: prepared.hasRest,
    restExecutor: prepared.hasRest ? restWire.restExecutor : undefined,
    suppliedQueryParams: runnerSuppliedQueryParams(restWire.getAuth),
    ...(restWire.rbacRestExecutor === undefined || !prepared.hasRest
      ? {}
      : { rbacRestExecutor: restWire.rbacRestExecutor }),
    restOps: prepared.restOps,
    discoveryRaw: prepared.discoveryMeta.discoveryRaw,
    // Read only by the shadow DinoResult constructor (Cleanup V2 task 2); tool inputs are unchanged.
    discovery: { graphqlOperations: prepared.discoveryMeta.graphqlOperations, introspectionLevel: prepared.discoveryMeta.introspectionLevel, read: discoveryRead({ structureSource: prepared.discoveryMeta.structureSource, hasRest: prepared.hasRest }) },
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

function credentialFailureField(code: ReleaseRefusalCode | undefined): { credentialFailure?: ReleaseRefusalCode } {
  return code === undefined ? {} : { credentialFailure: code };
}

/**
 * DIN-1504: the credential decision comes first. The spec is resolved (typed SCAN_API_SPEC_* on failure), then the
 * grant/hydrate decision; a refusal returns before the runner sends the Target anything. Discovery then runs with the
 * scan's own credential, so a Target that requires authentication for introspection can be discovered at all.
 */
export async function executeRunnerAssignment(
  opts: ScanExecuteDeps & { pipelineRunner: PipelineRunner },
): Promise<RunnerResult> {
  const { assignment } = opts;
  let restSpec: RunnerRestSpecResult;
  try {
    restSpec = await runnerRestSpec(opts);
  } catch (error) {
    return failedRunnerResult(assignment, error);
  }
  try {
    // The REST executor is wired with the credential up front (whether the Target has REST operations is known only
    // after discovery); the pipeline is handed it only when discovery found some.
    const restWire = await resolveRestExecutor(opts, true);
    if (!restWire.ok) return refusedRunnerResult(assignment, restWire);
    let prepared: PreparedScanContext;
    try {
      prepared = await prepareRunnerScanContext(opts, { restSpec, discoveryAuth: discoveryAuthOf(restWire.getAuth) });
    } catch (error) {
      return failedRunnerResult(assignment, error, restWire.authentication?.());
    }
    return await runPipeline(opts, prepared, restWire);
  } finally {
    await restSpec.cleanup();
  }
}

async function runPipeline(
  opts: ScanExecuteDeps & { pipelineRunner: PipelineRunner },
  prepared: PreparedScanContext,
  restWire: Extract<ResolvedRestExecutor, { ok: true }>,
): Promise<RunnerResult> {
  const { assignment, pipelineRunner } = opts;
  const wires = startLiveScanWires(opts);

  try {
    const result = await pipelineRunner(
      opts.buildPipelineOptions(assemblePipelineArgs(opts, prepared, restWire, wires)),
    );

    const schemaSnapshot = buildRunnerSchemaSnapshot({
      graphqlOperations: prepared.discoveryMeta.graphqlOperations,
      tenantId: opts.state.tenantId,
    });
    const signer = opts.attestationSigner ?? null;
    return await buildCompletedRunnerResult({
      assignment,
      result,
      cliVersion: CLI_VERSION,
      rotatedRefreshToken: restWire.rotatedRefreshToken(),
      authLost: restWire.authLost(),
      authentication: restWire.authentication?.(),
      ...credentialFailureField(restWire.credentialFailure?.()),
      cancelObserved: wires.cancelObserved(),
      schemaSnapshot,
      attest: (r) => (signer === null ? Promise.resolve(undefined) : attestCanonicalResult({ result: r, scanId: assignment.scanId, agentVersion: CLI_VERSION, signer })),
    });
  } catch (error) {
    // DIN-1492: context was acquired before this failure; the report of what the run proved survives it.
    return failedRunnerResult(assignment, error, restWire.authentication?.());
  } finally {
    wires.watch.stop();
    await wires.emitter.stop();
  }
}
