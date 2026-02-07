/**
 * Caches for the orchestrator layer.
 *
 * ResponseCache — caches query() results by content hash (SHA-256).
 *   15-min TTL, 100 max entries, LRU eviction.
 *
 * ModelListCache — caches listModels() results.
 *   30-sec TTL, single entry (latest result).
 *   Deduplicates the 3-4 listModels() calls that happen per tool invocation
 *   (pickCompressorModel, pickLargeContextModel, etc.)
 */

import { createHash } from "node:crypto";
import { QueryResponse, QueryOptions, ModelInfo } from "../providers/provider.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Response Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  response: QueryResponse;
  timestamp: number;
}

export interface ResponseCacheConfig {
  ttlMs: number;
  maxEntries: number;
}

export class ResponseCache {
  private cache: Map<string, CacheEntry> = new Map();
  private config: ResponseCacheConfig;

  constructor(config: ResponseCacheConfig) {
    this.config = config;
  }

  /** Build a cache key from query parameters. */
  key(model: string, prompt: string, options?: QueryOptions): string {
    const raw = `${model}|${prompt}|${JSON.stringify(options ?? {})}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  /** Get a cached response, or null if missing/expired. */
  get(key: string): QueryResponse | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.config.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Move to end for LRU (delete + re-add preserves Map insertion order)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.response;
  }

  /** Store a response in the cache. */
  set(key: string, response: QueryResponse): void {
    // LRU eviction: remove oldest entry if at capacity
    if (this.cache.size >= this.config.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, { response, timestamp: Date.now() });
  }

  /** Number of entries in cache. */
  get size(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// Model List Cache
// ---------------------------------------------------------------------------

export interface ModelListCacheConfig {
  ttlMs: number;
}

export class ModelListCache {
  private models: ModelInfo[] | null = null;
  private timestamp = 0;
  private config: ModelListCacheConfig;

  constructor(config: ModelListCacheConfig) {
    this.config = config;
  }

  /** Get cached model list, or null if stale/empty. */
  get(): ModelInfo[] | null {
    if (!this.models) return null;

    if (Date.now() - this.timestamp > this.config.ttlMs) {
      this.models = null;
      return null;
    }

    return this.models;
  }

  /** Store model list. */
  set(models: ModelInfo[]): void {
    this.models = models;
    this.timestamp = Date.now();
  }

  /** Invalidate the cache (e.g., when circuit breaker state changes). */
  invalidate(): void {
    this.models = null;
  }
}
