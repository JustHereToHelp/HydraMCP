/**
 * Orchestrator configuration — sensible defaults with env var overrides.
 */

export interface OrchestratorConfig {
  // Circuit breaker
  maxFailures: number;
  cooldownMs: number;

  // Query cache
  queryCacheTtlMs: number;
  queryCacheMaxEntries: number;

  // Model list cache
  modelListCacheTtlMs: number;

  // Feature flags
  enableCache: boolean;
  enableCircuitBreaker: boolean;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  maxFailures: 3,
  cooldownMs: 60_000, // 1 minute
  queryCacheTtlMs: 900_000, // 15 minutes
  queryCacheMaxEntries: 100,
  modelListCacheTtlMs: 30_000, // 30 seconds
  enableCache: true,
  enableCircuitBreaker: true,
};

/** Read config from env vars, falling back to defaults. */
export function loadConfig(
  overrides?: Partial<OrchestratorConfig>
): OrchestratorConfig {
  const env = process.env;

  return {
    maxFailures:
      overrides?.maxFailures ??
      intEnv(env.HYDRA_CB_MAX_FAILURES) ??
      DEFAULT_CONFIG.maxFailures,
    cooldownMs:
      overrides?.cooldownMs ??
      intEnv(env.HYDRA_CB_COOLDOWN_MS) ??
      DEFAULT_CONFIG.cooldownMs,
    queryCacheTtlMs:
      overrides?.queryCacheTtlMs ??
      intEnv(env.HYDRA_CACHE_TTL_MS) ??
      DEFAULT_CONFIG.queryCacheTtlMs,
    queryCacheMaxEntries:
      overrides?.queryCacheMaxEntries ??
      intEnv(env.HYDRA_CACHE_MAX_ENTRIES) ??
      DEFAULT_CONFIG.queryCacheMaxEntries,
    modelListCacheTtlMs:
      overrides?.modelListCacheTtlMs ??
      intEnv(env.HYDRA_MODEL_CACHE_TTL_MS) ??
      DEFAULT_CONFIG.modelListCacheTtlMs,
    enableCache:
      overrides?.enableCache ??
      boolEnv(env.HYDRA_CACHE_ENABLED) ??
      DEFAULT_CONFIG.enableCache,
    enableCircuitBreaker:
      overrides?.enableCircuitBreaker ??
      boolEnv(env.HYDRA_CB_ENABLED) ??
      DEFAULT_CONFIG.enableCircuitBreaker,
  };
}

function intEnv(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

function boolEnv(val: string | undefined): boolean | undefined {
  if (val === undefined) return undefined;
  return val === "true" || val === "1";
}
