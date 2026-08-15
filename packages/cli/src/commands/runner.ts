/**
 * dino runner register | start (Issue #1150).
 */

import os from 'node:os';
import {
  asTenantId,
  asRunnerId,
  createPinnedFetch,
  type TenantConfig,
  type RunnerJob,
  type RunnerResult,
} from '@dino/core';
import {
  runPipeline,
  type ToolName,
  type PipelineOptions,
  type Timer,
  SystemTimer,
} from '@dino/engine';
import { createCloudReporter } from '../runner/inngest-reporter';
import {
  startPollLoop,
  pollOnce,
  buildPollLoopConfig,
  RunnerUnauthorizedError,
} from '../runner/poll-loop';
import { installRunnerSignalHandlers, cleanupRunner } from '../runner/runner-lifecycle';
import { executeRunnerAssignment } from '../runner/runner-scan-execute';
import {
  createFileStateStorage,
  getDefaultRunnerStatePath,
  type RunnerState,
  type StateStorage,
} from '../runner/state-store';
import { maybeStartWakeServer } from '../runner/wake-server';
import { CliError } from '../shared/errors';
import { DEFAULT_REASONING_OPTS, perOpFindingsFromEnv } from '../shared/pipeline-helpers';
import { CLI_VERSION } from '../version';
import type { CommandContext } from '../shared/base-command';

export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_REGISTER_ENDPOINT = 'https://api.usedino.dev';

export type RunRunnerRegisterDeps = {
  storage?: StateStorage;
  httpClient?: HttpClient;
  statePath?: string;
};

export type RunRunnerStartDeps = {
  storage?: StateStorage;
  httpClient?: HttpClient;
  timer?: Timer;
  createReporter?: typeof createCloudReporter;
  createExecuteScan?: (state: RunnerState) => (a: RunnerJob) => Promise<RunnerResult>;
  /** Test seam - production uses poll-loop default (5s). */
  pollIntervalMs?: number;
  /** Test seam - production uses poll-loop default (60s cap). */
  maxBackoffMs?: number;
  /** Test seam - production uses 30_000ms. */
  hardShutdownMs?: number;
  /** Test seam - production uses true. */
  hardShutdownTimerUnref?: boolean;
  /** #70 test seams - production reads DINO_RUNNER_MODE / DINO_RUNNER_WAKE_SECRET / PORT from env. */
  runnerMode?: string;
  wakeSecret?: string;
  port?: number;
};

function runnerPlatformOs(): string {
  const p = os.platform();
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'windows';
  return p;
}

function runnerArchLabel(): string {
  const a = os.arch();
  if (a === 'x64') return 'x64';
  if (a === 'arm64') return 'arm64';
  return a;
}

function wrapRunnerPollHttpClient(inner: HttpClient): HttpClient {
  const meta = {
    version: CLI_VERSION,
    os: runnerPlatformOs(),
    arch: runnerArchLabel(),
  };
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (url.includes('/v1/runners/') && url.includes('/assignments')) {
      headers.set('x-dino-version', meta.version);
      headers.set('x-dino-os', meta.os);
      headers.set('x-dino-arch', meta.arch);
    }
    return inner(url, { ...init, headers });
  };
}

export type RunnerExecuteScanDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  rand?: () => number;
  /** Cloud-facing HTTP for live log emission + cancel watch (Spec B). Default: global fetch. */
  cloudHttpClient?: HttpClient;
  timer?: Timer;
};

function runnerDefaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms); // determinism:allowed - CfInboxOtpResolver poll seam (runner CLI)
  });
}

export function buildRunnerTenantConfig(
  tenantId: string,
  targetUrl: string,
  rest?: { source: string; specPath: string },
): TenantConfig {
  return {
    schemaVersion: 1,
    id: tenantId,
    name: 'Cloud runner',
    apis:
      rest === undefined
        ? [{ name: 'default', type: 'graphql', source: 'introspection' }]
        : [{ name: 'default', type: 'rest', source: rest.source, specPath: rest.specPath }],
    environments: {
      cloud: {
        endpoints: { default: targetUrl },
        timeout: 120_000,
        retries: 0,
      },
    },
    defaultEnvironment: 'cloud',
    auth: { adapter: 'none', adapterConfig: {}, roles: [] },
    agents: [],
  };
}

export function buildRunnerPipelineOptions(opts: {
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
}): PipelineOptions {
  const { state, assignment, hasRest } = opts;
  return {
    tenantId: state.tenantId,
    environment: 'cloud',
    trigger: 'manual',
    registry: opts.registry,
    executor: opts.executor,
    tools: opts.effectiveTools,
    perOpFindings: perOpFindingsFromEnv(),
    ...(assignment.command !== undefined ? { sentinelCommand: assignment.command } : {}),
    reasoningConfig: { ...DEFAULT_REASONING_OPTS, enabled: false, apiKey: null },
    tracker: opts.tracker,
    restExecutor: opts.restExecutor,
    restBaseUrl: hasRest ? assignment.targetUrl : undefined,
    openApiSpec: hasRest ? opts.discoveryRaw : undefined,
    restOperations: hasRest ? opts.restOps : undefined,
    agentVersion: CLI_VERSION,
    scanIdForAttestation: assignment.scanId,
    scanTargetUrl: assignment.targetUrl,
    ...(opts.rbacRoles === undefined ? {} : { rbacRoles: opts.rbacRoles }),
    ...(opts.rbacExpectations === undefined ? {} : { rbacExpectations: opts.rbacExpectations }),
    ...(opts.rbacDefaultExpectations === undefined
      ? {}
      : { rbacDefaultExpectations: opts.rbacDefaultExpectations }),
    ...(opts.tokenResolver === undefined ? {} : { tokenResolver: opts.tokenResolver }),
    ...(opts.rbacRestExecutor === undefined ? {} : { rbacRestExecutor: opts.rbacRestExecutor }),
    ...(opts.rbacDefaultProbeMode === undefined
      ? {}
      : { rbacDefaultProbeMode: opts.rbacDefaultProbeMode }),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
    ...(opts.onToolEvent === undefined ? {} : { onToolEvent: opts.onToolEvent }),
    ...(opts.abortSignal === undefined ? {} : { abortSignal: opts.abortSignal }),
  };
}

/**
 * Build the scan executor used by `dino runner start`.
 * `pipelineRunner` is injectable for tests.
 */
export function createRunnerExecuteScan(
  state: RunnerState,
  pipelineRunner: typeof runPipeline = runPipeline,
  scanDeps: RunnerExecuteScanDeps = {},
): (assignment: RunnerJob) => Promise<RunnerResult> {
  const now = scanDeps.now ?? (() => Date.now()); // determinism:allowed - default seam for production runner
  const sleep = scanDeps.sleep ?? runnerDefaultSleep;
  // #1850 — the runner's outbound fetch (flow-runner auth + REST executor) hits CUSTOMER-controlled URLs;
  // pin to the validated IP so a rebinding target cannot reach the runner's localhost / metadata / other tenants.
  const fetchImpl = scanDeps.fetchImpl ?? createPinnedFetch();
  // determinism:allowed — CSPRNG jitter seam (avoids S2245: PRNG Math.random hotspot)
  const rand =
    scanDeps.rand ?? (() => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32);
  // Cloud-facing HTTP (log emission + cancel watch, Spec B) — deliberately NOT the pinned customer
  // fetch: it talks to the Dino cloud, like the reporter.
  const cloudHttpClient =
    scanDeps.cloudHttpClient ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const timer = scanDeps.timer ?? SystemTimer;

  return async (assignment: RunnerJob): Promise<RunnerResult> => {
    if (assignment.tenantId !== state.tenantId) {
      return { scanId: assignment.scanId, status: 'failed', error: 'tenant_mismatch' };
    }
    try {
      return await executeRunnerAssignment({
        state,
        assignment,
        pipelineRunner,
        fetchImpl,
        now,
        sleep,
        rand,
        cloudHttpClient,
        timer,
        buildPipelineOptions: buildRunnerPipelineOptions,
        buildTenantConfig: buildRunnerTenantConfig,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { scanId: assignment.scanId, status: 'failed', error: message };
    }
  };
}

interface RegisterFlags {
  token: string;
  name: string;
  tenantId: string;
  endpoint: string;
}

function parseRegisterFlags(flags: Record<string, unknown>): RegisterFlags | null {
  const token = typeof flags.token === 'string' ? flags.token : '';
  const name = typeof flags.name === 'string' ? flags.name : '';
  const tenantId = typeof flags.tenant === 'string' ? flags.tenant : '';
  const endpoint =
    typeof flags.endpoint === 'string' && flags.endpoint.length > 0
      ? flags.endpoint.replace(/\/$/, '')
      : DEFAULT_REGISTER_ENDPOINT;

  if (!token || !name || !tenantId) return null;
  return { token, name, tenantId, endpoint };
}

async function formatRegisterError(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return '';
  try {
    const j = JSON.parse(text) as { error?: string };
    return j.error ? `: ${j.error}` : '';
  } catch {
    return `: ${text.slice(0, 200)}`;
  }
}

export async function runRunnerRegister(
  flags: Record<string, unknown>,
  deps: RunRunnerRegisterDeps = {},
): Promise<number> {
  const httpClient = deps.httpClient ?? ((url, init) => globalThis.fetch(url, init));
  const statePath = deps.statePath ?? getDefaultRunnerStatePath();
  const storage = deps.storage ?? createFileStateStorage(statePath);

  const parsed = parseRegisterFlags(flags);
  if (!parsed) {
    throw new CliError(
      'Usage: dino runner register --token <admin-api-key> --name <name> --tenant <tenantId> [--endpoint <url>]',
      2,
      undefined,
      undefined,
      'usage',
    );
  }

  const registerUrl = `${parsed.endpoint}/v1/runners/register`;
  let res: Response;
  try {
    res = await httpClient(registerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${parsed.token}`,
      },
      body: JSON.stringify({ name: parsed.name, tenantId: parsed.tenantId }),
    });
  } catch (e) {
    throw new CliError(
      `Registration request failed: ${e instanceof Error ? e.message : String(e)}`,
      70,
      undefined,
      e,
    );
  }

  if (!res.ok) {
    const detail = await formatRegisterError(res);
    throw new CliError(`Registration failed (HTTP ${String(res.status)})${detail}`, 70);
  }

  const body = (await res.json()) as {
    id: string;
    tenantId: string;
    token: string;
    registeredAt: string;
    cloudEndpoint?: string;
  };

  const state: RunnerState = {
    runnerId: asRunnerId(body.id),
    tenantId: asTenantId(body.tenantId),
    token: body.token,
    cloudEndpoint: body.cloudEndpoint ?? parsed.endpoint,
    registeredAt: body.registeredAt,
  };

  await storage.write(state);
  console.info(`Runner registered. runnerId=${body.id}`);
  return 0;
}

function createRunnerLogger() {
  return {
    info(msg: string, data?: Record<string, unknown>): void {
      console.info(JSON.stringify(data ? { event: msg, ...data } : { event: msg }));
    },
    error(msg: string, data?: Record<string, unknown>): void {
      console.error(JSON.stringify(data ? { event: msg, ...data } : { event: msg }));
    },
  };
}

function rethrowRunnerPollError(e: unknown): never {
  if (e instanceof RunnerUnauthorizedError) {
    throw new CliError(
      'Runner revoked or token expired. Re-register with `dino runner register`.',
      70,
      undefined,
      e,
    );
  }
  throw e;
}

export async function runRunnerStart(
  _flags: Record<string, unknown>,
  deps: RunRunnerStartDeps = {},
): Promise<number> {
  const statePath = getDefaultRunnerStatePath();
  const storage = deps.storage ?? createFileStateStorage(statePath);
  const innerHttp = deps.httpClient ?? ((url, init) => globalThis.fetch(url, init));
  const httpClient = wrapRunnerPollHttpClient(innerHttp);
  const timer = deps.timer ?? SystemTimer;
  const makeReporter = deps.createReporter ?? createCloudReporter;

  const state = await storage.read();
  if (!state) {
    throw new CliError(
      'Runner not registered. Run: dino runner register --token <admin-api-key> --name <name> --tenant <tenantId>',
      2,
      undefined,
      undefined,
      'usage',
    );
  }

  const shutdown = installRunnerSignalHandlers(timer, {
    hardShutdownMs: deps.hardShutdownMs,
    hardShutdownTimerUnref: deps.hardShutdownTimerUnref,
  });
  const reporter = makeReporter(state.cloudEndpoint, state.token, httpClient, timer);
  const executeScan =
    deps.createExecuteScan?.(state) ??
    createRunnerExecuteScan(state, runPipeline, { cloudHttpClient: httpClient, timer });
  const logger = createRunnerLogger();
  const pollConfig = buildPollLoopConfig({
    state,
    httpClient,
    reporter,
    executeScan,
    logger,
    signal: shutdown.signal,
    timer,
    pollIntervalMs: deps.pollIntervalMs,
    maxBackoffMs: deps.maxBackoffMs,
  });
  const wakeServer = maybeStartWakeServer({
    onWake: () => pollOnce(pollConfig),
    logger,
    mode: deps.runnerMode,
    wakeSecret: deps.wakeSecret,
    port: deps.port,
  });

  try {
    await startPollLoop(pollConfig);
  } catch (e) {
    rethrowRunnerPollError(e);
  } finally {
    cleanupRunner(timer, shutdown, wakeServer);
  }

  console.info('Shutting down');
  return 0;
}

export async function runRunnerFromFlags(flags: Record<string, unknown>): Promise<number> {
  const sub = flags._1 as string | undefined;
  if (sub === 'register') return runRunnerRegister(flags);
  if (sub === 'start') return runRunnerStart(flags);
  throw new CliError('Usage: dino runner <register|start>', 2, undefined, undefined, 'usage');
}

export async function runRunner(
  _ctx: CommandContext,
  flags: Record<string, unknown>,
): Promise<number> {
  return runRunnerFromFlags(flags);
}
