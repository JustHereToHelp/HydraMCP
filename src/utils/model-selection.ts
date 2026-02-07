/**
 * model-selection — Shared model selection utilities.
 *
 * Centralizes model preference lists and selection logic so tools
 * don't duplicate the same heuristics. Two strategies:
 *
 * 1. Large-context models (Gemini 1M) — for tasks with big inputs
 *    (session recap, file analysis)
 * 2. Cheap/fast models — for compression/distillation
 *    (already in compress.ts as pickCompressorModel)
 */

import { Provider } from "../providers/provider.js";

// ---------------------------------------------------------------------------
// Large-context model selection
// ---------------------------------------------------------------------------

/**
 * Preferred models for large-context tasks, in priority order.
 * These models can handle 500K+ tokens of input.
 * Gemini 2.5 Flash is ideal: 1M context, fast, cheap on subscription quota.
 */
export const LARGE_CONTEXT_MODELS = [
  "gemini-2.5-flash",       // 1M context, fast, best for large inputs
  "gemini-2.5-flash-lite",  // 1M context, fastest
  "gemini-3-flash",         // likely 1M context
  "gemini-3-pro",           // likely 1M+ context
  "gemini-2.5-pro",         // 1M context, slower but smarter
];

/**
 * Pick a model suitable for large-context tasks — prefers Gemini models
 * with 1M+ context windows. Falls back to any available model.
 */
export async function pickLargeContextModel(
  provider: Provider,
  preferredModel?: string
): Promise<string | null> {
  if (preferredModel) return preferredModel;

  try {
    const available = await provider.listModels();
    if (available.length === 0) return null;

    // Try preferred models in priority order
    for (const preferred of LARGE_CONTEXT_MODELS) {
      const match = available.find((m) =>
        m.id.toLowerCase().includes(preferred)
      );
      if (match) return match.id;
    }

    // Fallback: any gemini model
    const anyGemini = available.find((m) =>
      m.id.toLowerCase().includes("gemini")
    );
    if (anyGemini) return anyGemini.id;

    // Last resort: any model
    return available[0].id;
  } catch {
    return null;
  }
}
