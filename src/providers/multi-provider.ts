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

export class MultiProvider implements Provider {
  name = "HydraMCP";
  private providers: Map<string, Provider> = new Map();

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

    return results.flatMap((r) =>
      r.status === "fulfilled" ? r.value : []
    );
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
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

      return provider.query(modelId, prompt, options);
    }

    // No prefix — try each provider until one works
    const errors: string[] = [];
    for (const [key, provider] of this.providers) {
      try {
        const response = await provider.query(model, prompt, options);
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
}
