/**
 * Metrics — per-model tracking for observability.
 *
 * In-memory only, resets on server restart. Lightweight tracking
 * of queries, latency, success rate, and tokens per model.
 * Used for diagnostics and future smart routing decisions.
 */

export interface ModelStats {
  queries: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  totalTokens: number;
  lastQueryTime: number;
}

export interface SessionSummary {
  totalQueries: number;
  totalFailures: number;
  cacheHits: number;
  cacheTokensSaved: number;
}

export class Metrics {
  private stats: Map<string, ModelStats> = new Map();

  // Session-level counters
  private sessionCacheHits = 0;
  private sessionCacheTokensSaved = 0;

  /** Record a query result. */
  record(
    model: string,
    latencyMs: number,
    success: boolean,
    tokens?: number
  ): void {
    const existing = this.stats.get(model) ?? {
      queries: 0,
      successes: 0,
      failures: 0,
      totalLatencyMs: 0,
      totalTokens: 0,
      lastQueryTime: 0,
    };

    existing.queries++;
    if (success) {
      existing.successes++;
    } else {
      existing.failures++;
    }
    existing.totalLatencyMs += latencyMs;
    existing.totalTokens += tokens ?? 0;
    existing.lastQueryTime = Date.now();

    this.stats.set(model, existing);
  }

  /** Get stats for a specific model. */
  getModelStats(model: string): ModelStats | undefined {
    return this.stats.get(model);
  }

  /** Get stats for all tracked models. */
  getAllStats(): Map<string, ModelStats> {
    return new Map(this.stats);
  }

  /** Get average latency for a model (0 if no data). */
  avgLatency(model: string): number {
    const s = this.stats.get(model);
    if (!s || s.queries === 0) return 0;
    return Math.round(s.totalLatencyMs / s.queries);
  }

  /** Get success rate for a model (1.0 if no data). */
  successRate(model: string): number {
    const s = this.stats.get(model);
    if (!s || s.queries === 0) return 1.0;
    return s.successes / s.queries;
  }

  /** Record a cache hit with estimated tokens saved. */
  recordCacheHit(tokensSaved: number): void {
    this.sessionCacheHits++;
    this.sessionCacheTokensSaved += tokensSaved;
  }

  /** Get session-level summary for observability. */
  getSessionSummary(): SessionSummary {
    let totalQueries = 0;
    let totalFailures = 0;
    for (const s of this.stats.values()) {
      totalQueries += s.queries;
      totalFailures += s.failures;
    }
    return {
      totalQueries,
      totalFailures,
      cacheHits: this.sessionCacheHits,
      cacheTokensSaved: this.sessionCacheTokensSaved,
    };
  }
}
