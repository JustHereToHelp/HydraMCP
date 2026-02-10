/**
 * Fallback chains — when a model is down, try alternatives.
 * Configured via HYDRA_FALLBACKS env var (JSON string).
 *
 * Example: HYDRA_FALLBACKS='{"cliproxy/gpt-5.3-codex": ["cliproxy/gpt-5.2", "cliproxy/gpt-5.1"]}'
 */
import { logger } from "./logger.js";

type FallbackConfig = Record<string, string[]>;

let fallbackConfig: FallbackConfig | null = null;

function loadConfig(): FallbackConfig {
  if (fallbackConfig !== null) return fallbackConfig;

  const raw = process.env.HYDRA_FALLBACKS;
  if (!raw) {
    fallbackConfig = {};
    return fallbackConfig;
  }

  try {
    fallbackConfig = JSON.parse(raw) as FallbackConfig;
    logger.info(`Loaded fallback chains for ${Object.keys(fallbackConfig).length} model(s)`);
  } catch (err) {
    logger.error(`Failed to parse HYDRA_FALLBACKS: ${err}`);
    fallbackConfig = {};
  }

  return fallbackConfig;
}

export function getFallbacks(model: string): string[] {
  const config = loadConfig();
  const modelName = model.includes("/") ? model.split("/").pop()! : model;
  return config[model] ?? config[modelName] ?? [];
}

export function hasFallback(model: string): boolean {
  return getFallbacks(model).length > 0;
}
