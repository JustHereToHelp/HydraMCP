/**
 * SmartProvider — the orchestrator layer.
 *
 * Wraps any Provider (typically MultiProvider) and adds:
 * - Circuit breaker: stop calling failing models, auto-recover
 * - Response cache: deduplicate identical queries (15-min TTL)
 * - Model list cache: deduplicate listModels() calls (30-sec TTL)
 * - Metrics: per-model latency, success rate, token usage
 *
 * Implements the Provider interface, so all tools work transparently.
 * Zero tool code changes required.
 */

import {
  Provider,
  ModelInfo,
  QueryOptions,
  QueryResponse,
} from "../providers/provider.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { ResponseCache, ModelListCache } from "./cache.js";
import { Metrics, SessionSummary } from "./metrics.js";
import {
  OrchestratorConfig,
  DEFAULT_CONFIG,
  loadConfig,
} from "./config.js";
import { logger } from "../utils/logger.js";

export class SmartProvider implements Provider {
  name = "HydraMCP (Smart)";

  private inner: Provider;
  private config: OrchestratorConfig;
  private circuitBreaker: CircuitBreaker;
  private queryCache: ResponseCache;
  private modelListCache: ModelListCache;
  private metrics: Metrics;

  constructor(inner: Provider, overrides?: Partial<OrchestratorConfig>) {
    this.inner = inner;
    this.config = loadConfig(overrides);

    this.circuitBreaker = new CircuitBreaker({
      maxFailures: this.config.maxFailures,
      cooldownMs: this.config.cooldownMs,
    });

    this.queryCache = new ResponseCache({
      ttlMs: this.config.queryCacheTtlMs,
      maxEntries: this.config.queryCacheMaxEntries,
    });

    this.modelListCache = new ModelListCache({
      ttlMs: this.config.modelListCacheTtlMs,
    });

    this.metrics = new Metrics();

    logger.info(
      `SmartProvider initialized: cache=${this.config.enableCache}, ` +
        `circuit-breaker=${this.config.enableCircuitBreaker}, ` +
        `cache-ttl=${this.config.queryCacheTtlMs}ms, ` +
        `cb-threshold=${this.config.maxFailures} failures`
    );
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  async listModels(): Promise<ModelInfo[]> {
    // Get models from cache or inner provider
    let models: ModelInfo[];
    if (this.config.enableCache) {
      const cached = this.modelListCache.get();
      if (cached) {
        logger.debug("listModels: using cached provider list");
        models = cached;
      } else {
        models = await this.inner.listModels();
        this.modelListCache.set(models);
      }
    } else {
      models = await this.inner.listModels();
    }

    // ALWAYS filter circuit-broken models, even from cache.
    // Circuit breaker state changes between cache refreshes, so we must
    // check on every call to avoid returning stale/broken models.
    if (this.config.enableCircuitBreaker) {
      const openModels = this.circuitBreaker.getOpenModels();
      if (openModels.length > 0) {
        const filtered = models.filter((m) => !openModels.includes(m.id));
        logger.info(
          `listModels: ${openModels.length} model(s) hidden by circuit breaker`
        );
        return filtered;
      }
    }

    return models;
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    // Step 1: Check circuit breaker
    if (
      this.config.enableCircuitBreaker &&
      this.circuitBreaker.isOpen(model)
    ) {
      this.metrics.record(model, 0, false);
      throw new Error(
        `Model "${model}" is temporarily unavailable (circuit breaker open after consecutive failures). ` +
          `**Recovery:** Try a different model, or wait ~${Math.round(this.config.cooldownMs / 1000)}s for automatic recovery. ` +
          `Call list_models to see available models.`
      );
    }

    // Step 2: Check query cache
    if (this.config.enableCache) {
      const cacheKey = this.queryCache.key(model, prompt, options);
      const cached = this.queryCache.get(cacheKey);
      if (cached) {
        const cachedTokens = cached.usage?.total_tokens ?? 0;
        logger.debug(`query: cache hit for ${model} (~${cachedTokens} tokens saved)`);
        this.metrics.record(model, 0, true, cachedTokens);
        this.metrics.recordCacheHit(cachedTokens);
        return { ...cached, latency_ms: 0 };
      }
    }

    // Step 3: Query inner provider
    const startTime = Date.now();
    try {
      const response = await this.inner.query(model, prompt, options);
      const latency = Date.now() - startTime;

      // Record success
      if (this.config.enableCircuitBreaker) {
        this.circuitBreaker.recordSuccess(model);
      }
      this.metrics.record(
        model,
        latency,
        true,
        response.usage?.total_tokens
      );

      // Cache the response
      if (this.config.enableCache) {
        const cacheKey = this.queryCache.key(model, prompt, options);
        this.queryCache.set(cacheKey, response);
      }

      return response;
    } catch (err) {
      const latency = Date.now() - startTime;

      // Record failure
      if (this.config.enableCircuitBreaker) {
        this.circuitBreaker.recordFailure(model);
      }
      this.metrics.record(model, latency, false);

      throw err;
    }
  }

  /** Get orchestrator metrics (for diagnostics). */
  getMetrics(): Metrics {
    return this.metrics;
  }

  /** Get circuit breaker (for diagnostics). */
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  /** Get current cache size (for diagnostics). */
  getCacheSize(): number {
    return this.queryCache.size;
  }

  /** Get session-level summary (for list_models footer). */
  getSessionSummary(): SessionSummary {
    return this.metrics.getSessionSummary();
  }
}
