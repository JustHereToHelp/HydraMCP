/**
 * MultiProvider — routes requests across multiple backends.
 *
 * This is the glue. Instead of the MCP server knowing about one provider,
 * it talks to MultiProvider which knows about ALL of them.
 *
 * Model routing works by prefix:
 *   "ollama/llama3"      → OllamaProvider.query("llama3", ...)
 *   "cliproxy/gpt-4o"    → CLIProxyAPIProvider.query("gpt-4o", ...)
 *
 * Or without prefix, we try each provider until one has the model.
 * This keeps the tool layer simple — it just calls query() and
 * MultiProvider figures out where to send it.
 */

import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";
import { logger } from "../utils/logger.js";
import { CircuitBreaker, CircuitOpenError } from "../utils/circuit-breaker.js";
import { getFallbacks } from "../utils/fallback-chains.js";

const BLOCKED_MODELS = new Set(["gpt-5.3-codex"]);

export class MultiProvider implements Provider {
  name = "HydraMCP";
  private providers: Map<string, Provider> = new Map();
  private circuitBreaker = new CircuitBreaker();
  private queryCount = 0;

  register(key: string, provider: Provider): void {
    this.providers.set(key, provider);
    logger.info(`Registered provider: ${key} (${provider.name})`);
  }

  async healthCheck(): Promise<boolean> {
    const checks = await Promise.all(
      [...this.providers.entries()].map(async ([key, p]) => {
        const healthy = await p.healthCheck();
        if (!healthy) logger.warn(`Provider ${key} is not reachable`);
        return healthy;
      })
    );
    // Healthy if at least one provider is up
    return checks.some((c) => c);
  }

  async listModels(): Promise<ModelInfo[]> {
    const results = await Promise.allSettled(
      [...this.providers.entries()].map(async ([key, p]) => {
        const models = await p.listModels();
        // Prefix model IDs with provider key so users can target specific backends
        return models.map((m) => ({
          ...m,
          id: `${key}/${m.id}`,
          provider: key,
        }));
      })
    );

    return results
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .filter(
        (m) =>
          !BLOCKED_MODELS.has(m.id) &&
          !BLOCKED_MODELS.has(m.id.split("/").pop() ?? "")
      );
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    // Check if model is blocked
    const modelName = model.includes("/")
      ? model.substring(model.indexOf("/") + 1)
      : model;
    if (BLOCKED_MODELS.has(model) || BLOCKED_MODELS.has(modelName)) {
      throw new Error(
        `Model "${model}" is blocked. It has been removed from the available models.`
      );
    }

    // Check for explicit prefix: "ollama/llama3" or "cliproxy/gpt-4o"
    const slashIndex = model.indexOf("/");
    if (slashIndex > 0) {
      const providerKey = model.substring(0, slashIndex);
      const modelId = model.substring(slashIndex + 1);
      const provider = this.providers.get(providerKey);

      if (!provider) {
        throw new Error(
          `Unknown provider "${providerKey}". Available: ${[...this.providers.keys()].join(", ")}`
        );
      }

      return this.queryWithResilience(model, providerKey, provider, modelId, prompt, options);
    }

    // No prefix — try each provider until one works
    const errors: string[] = [];
    for (const [key, provider] of this.providers) {
      try {
        const response = await this.queryWithResilience(
          `${key}/${model}`, key, provider, model, prompt, options
        );
        return response;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${key}: ${msg}`);
      }
    }

    throw new Error(
      `No provider could handle model "${model}".\n${errors.join("\n")}`
    );
  }

  private async queryWithResilience(
    model: string,
    providerKey: string,
    provider: Provider,
    modelId: string,
    prompt: string,
    options?: QueryOptions,
    depth: number = 0
  ): Promise<QueryResponse> {
    const fullModelId = `${providerKey}/${modelId}`;

    try {
      const result = await this.circuitBreaker.execute(fullModelId, () =>
        provider.query(modelId, prompt, options)
      );
      this.logHealthPeriodically();
      return result;
    } catch (err) {
      // On failure (including CircuitOpenError), try fallback chain
      if (depth < 2) {
        const fallbacks = getFallbacks(fullModelId);
        for (const fallbackModel of fallbacks) {
          try {
            logger.info(`Falling back from ${fullModelId} to ${fallbackModel}`);
            const fallbackResult = await this.query(fallbackModel, prompt, options);
            return { ...fallbackResult, fallback_from: fullModelId };
          } catch {
            // fallback also failed, try next
          }
        }
      }
      throw err;
    }
  }

  private logHealthPeriodically(): void {
    this.queryCount++;
    if (this.queryCount % 100 === 0) {
      const health = this.circuitBreaker.getHealthSummary();
      const summary = Object.entries(health)
        .filter(([_, s]) => s.state !== "CLOSED" || s.failures > 0)
        .map(([m, s]) => `${m}: ${s.state} (${s.failures}F/${s.totalRequests}T)`)
        .join(", ");
      if (summary) logger.info(`Health summary: ${summary}`);
    }
  }

  getHealth(): Record<string, { state: string; failures: number; successes: number; totalRequests: number }> {
    return this.circuitBreaker.getHealthSummary();
  }
}
