/**
 * Reasoning model detection — identifies models that use internal
 * chain-of-thought and need special token handling.
 *
 * Problem: Thinking models (DeepSeek-r1, Qwen3-235b, etc.) burn through
 * tokens on internal reasoning. A max_tokens of 2000 might mean 1900
 * tokens of thinking + 100 tokens of visible response (or 0 visible).
 *
 * Solution: Detect these models and boost the token budget so both
 * the reasoning AND the visible response have room.
 */

/** Patterns that identify reasoning/thinking models (case-insensitive) */
const REASONING_PATTERNS: RegExp[] = [
  /deepseek-r1/i,
  /qwen3-235b/i,
  /qwen3-30b/i,       // QwQ-32B often served as qwen3-30b
  /\bo[13]-/i,         // OpenAI o1-*, o3-*
  /\bo[13]$/i,         // OpenAI o1, o3
  /gemini.*think/i,    // Gemini thinking variants
  /gemini-3-pro/i,     // Gemini 3 Pro does internal reasoning
];

/**
 * Check if a model name matches a known reasoning/thinking model.
 */
export function isReasoningModel(model: string): boolean {
  return REASONING_PATTERNS.some((p) => p.test(model));
}

/**
 * For reasoning models, return a boosted max_tokens value.
 * The boost ensures the model has room for both chain-of-thought
 * and the visible response.
 *
 * Non-reasoning models pass through unchanged.
 */
export function adjustMaxTokens(model: string, requestedTokens: number): number {
  if (!isReasoningModel(model)) return requestedTokens;

  // 4x multiplier, floor of 4096, ceiling of 16384
  const boosted = Math.max(4096, requestedTokens * 4);
  return Math.min(boosted, 16384);
}
