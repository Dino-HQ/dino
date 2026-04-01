/**
 * @dino/reasoning — Reasoning config from environment variables
 *
 * Zod-validated parser. Fail-closed when enabled but API key missing.
 */

import { z } from 'zod';

// --- Env var names ---

const ENV = {
  ENABLED: 'DINO_REASONING_ENABLED',
  PROVIDER_KEY: 'ANTHROPIC_API_KEY',
  MODEL: 'DINO_REASONING_MODEL',
  MAX_COST: 'DINO_REASONING_MAX_COST_PER_RUN',
  CACHE_TTL: 'DINO_REASONING_CACHE_TTL',
  TIMEOUT: 'DINO_REASONING_TIMEOUT_MS',
  COST_INPUT: 'DINO_REASONING_COST_INPUT',
  COST_OUTPUT: 'DINO_REASONING_COST_OUTPUT',
} as const;

// --- Defaults ---

const DEFAULTS = {
  ENABLED: false,
  MODEL: 'claude-sonnet-4-5-20250514',
  MAX_COST_USD: 1,
  CACHE_TTL_MINUTES: 60,
  TIMEOUT_MS: 30_000,
} as const;

// --- Types ---

/** Parsed, validated reasoning configuration from environment variables. */
export interface ReasoningConfig {
  /** Whether reasoning is enabled (from DINO_REASONING_ENABLED, default: false — opt-in) */
  enabled: boolean;
  /** Anthropic API key (null when disabled — only validated when enabled) */
  apiKey: string | null;
  /** Model ID for the Anthropic provider (from DINO_REASONING_MODEL) */
  model: string;
  /** Maximum cost per reasoning run in USD (from DINO_REASONING_MAX_COST_PER_RUN) */
  maxCostPerRunUsd: number;
  /** Cache TTL in milliseconds (from DINO_REASONING_CACHE_TTL, converted from minutes) */
  cacheTtlMs: number;
  /** Provider timeout in milliseconds (from DINO_REASONING_TIMEOUT_MS, default: 30000) */
  timeoutMs: number;
  /** Override input cost per 1K tokens (from DINO_REASONING_COST_INPUT). Paired with costPer1kOutput. */
  costPer1kInput?: number;
  /** Override output cost per 1K tokens (from DINO_REASONING_COST_OUTPUT). Paired with costPer1kInput. */
  costPer1kOutput?: number;
}

// --- Helpers ---

function parseEnabled(val: string | undefined): boolean {
  if (val === undefined) return DEFAULTS.ENABLED;
  const lower = val.toLowerCase();
  return lower === 'true' || val === '1';
}

function parseOptionalPositiveNumber(
  val: string | undefined,
  envVar: string,
  defaultVal: number,
): number {
  if (val === undefined || val.trim() === '') return defaultVal;
  const result = z.coerce
    .number()
    .positive({ message: `${envVar} must be a positive number` })
    .safeParse(val);
  if (!result.success) {
    throw new Error(`${envVar} must be a positive number`);
  }
  return result.data;
}

function parseOptionalNonNegativeNumber(
  val: string | undefined,
  envVar: string,
  defaultVal: number,
): number {
  if (val === undefined || val.trim() === '') return defaultVal;
  const result = z.coerce
    .number()
    .min(0, { message: `${envVar} must be a non-negative number` })
    .safeParse(val);
  if (!result.success) {
    throw new Error(`${envVar} must be a non-negative number`);
  }
  return result.data;
}

function parseOptionalCostField(val: string | undefined, envVar: string): number | undefined {
  if (val === undefined || val.trim() === '') return undefined;
  const result = z.coerce
    .number()
    .min(0, { message: `${envVar} must be a non-negative number` })
    .finite({ message: `${envVar} must be a finite number` })
    .safeParse(val);
  if (!result.success) {
    throw new Error(`${envVar} must be a finite non-negative number`);
  }
  return result.data;
}

/**
 * Parse and validate reasoning-related environment variables.
 * Uses Zod for validation. Fail-closed: throws if enabled but API key missing.
 *
 * @param env - Environment variables (defaults to process.env). Inject for testing.
 * @returns Validated ReasoningConfig
 * @throws Error with actionable message if validation fails
 */
export function parseReasoningConfig(
  env: Record<string, string | undefined> = process.env,
): ReasoningConfig {
  const enabled = parseEnabled(env[ENV.ENABLED]);
  // B16 (#589): CLI uses DINO_AI_KEY, reasoning reads ANTHROPIC_API_KEY — check both
  // B16 (#589): Fall back to DINO_AI_KEY if ANTHROPIC_API_KEY is missing or empty
  const anthropicKey = env[ENV.PROVIDER_KEY]?.trim();
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string should fall through to DINO_AI_KEY
  const apiKeyRaw = anthropicKey || env['DINO_AI_KEY'];
  const apiKeyTrimmed = typeof apiKeyRaw === 'string' ? apiKeyRaw.trim() : '';

  if (enabled && !apiKeyTrimmed) {
    throw new Error(
      'Reasoning is enabled (DINO_REASONING_ENABLED=true) but no API key found. ' +
        'Set ANTHROPIC_API_KEY or DINO_AI_KEY, or disable reasoning with DINO_REASONING_ENABLED=false.',
    );
  }

  const maxCostPerRunUsd = parseOptionalPositiveNumber(
    env[ENV.MAX_COST],
    ENV.MAX_COST,
    DEFAULTS.MAX_COST_USD,
  );
  const cacheTtlMinutes = parseOptionalNonNegativeNumber(
    env[ENV.CACHE_TTL],
    ENV.CACHE_TTL,
    DEFAULTS.CACHE_TTL_MINUTES,
  );
  const cacheTtlMs = cacheTtlMinutes * 60 * 1000;
  const timeoutMs = parseOptionalPositiveNumber(env[ENV.TIMEOUT], ENV.TIMEOUT, DEFAULTS.TIMEOUT_MS);

  const modelTrimmed = env[ENV.MODEL]?.trim();
  const model = modelTrimmed !== undefined && modelTrimmed !== '' ? modelTrimmed : DEFAULTS.MODEL;

  const costPer1kInput = parseOptionalCostField(env[ENV.COST_INPUT], ENV.COST_INPUT);
  const costPer1kOutput = parseOptionalCostField(env[ENV.COST_OUTPUT], ENV.COST_OUTPUT);

  // Paired validation — both or neither
  if ((costPer1kInput !== undefined) !== (costPer1kOutput !== undefined)) {
    throw new Error(
      `${ENV.COST_INPUT} and ${ENV.COST_OUTPUT} must both be set or both omitted. ` +
        'Partial cost overrides create invalid blended pricing.',
    );
  }

  return {
    enabled,
    apiKey: enabled ? apiKeyTrimmed : null,
    model,
    maxCostPerRunUsd,
    cacheTtlMs,
    timeoutMs,
    costPer1kInput,
    costPer1kOutput,
  };
}
