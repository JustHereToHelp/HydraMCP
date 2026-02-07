/**
 * compress — Distill a model response to fit a token budget.
 *
 * Uses a cheap/fast model to compress a verbose response while
 * preserving all actionable details (file paths, code, errors,
 * function names, commands). This is distillation, not summarization.
 *
 * Designed as a shared utility so other tools can reuse it.
 */

import { Provider, QueryResponse } from "../providers/provider.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompressionResult {
  content: string;
  compressed: boolean;
  compressorModel?: string;
  compressorLatency?: number;
  originalTokens?: number;
  compressedTokens?: number;
  /** Original response content before compression (for escape hatch / quality comparison). */
  rawContent?: string;
}

// ---------------------------------------------------------------------------
// Model selection — pick cheapest/fastest available
// ---------------------------------------------------------------------------

const PREFERRED_COMPRESSOR_MODELS = [
  "gemini-2.5-flash-lite", // Cheapest, fastest
  "gemini-2.5-flash", // Fast, cheap, 1M context
  "gemini-3-flash", // Flash-class
  "claude-3-5-haiku", // Fast Claude
  "claude-haiku-4-5", // Newer Haiku
  "gpt-5-codex-mini", // Small, fast GPT
  "gpt-5.1-codex-mini", // Small, fast GPT variant
];

export async function pickCompressorModel(
  provider: Provider,
  excludeModel?: string
): Promise<string | null> {
  try {
    const available = await provider.listModels();
    if (available.length === 0) return null;

    // Build exclusion set (don't compress with the same model that generated)
    const excludeLower = excludeModel?.toLowerCase();
    const excludeBase = excludeModel?.split("/").pop()?.toLowerCase();

    function isExcluded(id: string): boolean {
      if (!excludeLower) return false;
      const lower = id.toLowerCase();
      return lower === excludeLower || lower === excludeBase;
    }

    // Try preferred models in priority order
    for (const preferred of PREFERRED_COMPRESSOR_MODELS) {
      const match = available.find(
        (m) =>
          m.id.toLowerCase().includes(preferred) && !isExcluded(m.id)
      );
      if (match) return match.id;
    }

    // Fallback: any model that isn't the worker
    const fallback = available.find((m) => !isExcluded(m.id));
    if (fallback) return fallback.id;

    // Last resort: even the same model
    return available[0].id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token estimation & skip logic
// ---------------------------------------------------------------------------

/**
 * Determine if compression is needed. Skips if the response is within
 * 20% of the budget — not worth the latency for marginal savings.
 */
export function shouldCompress(
  response: QueryResponse,
  maxResponseTokens: number
): boolean {
  const threshold = maxResponseTokens * 1.2;

  // Use actual token count if available (more accurate)
  if (response.usage?.completion_tokens) {
    return response.usage.completion_tokens > threshold;
  }

  // Fallback: estimate from character count (industry standard ~4 chars/token)
  const estimatedTokens = Math.ceil(response.content.length / 4);
  return estimatedTokens > threshold;
}

// ---------------------------------------------------------------------------
// Compression prompt
// ---------------------------------------------------------------------------

const COMPRESSION_SYSTEM_PROMPT =
  "You are a response distiller. You compress AI model responses to fit a token budget " +
  "while preserving ALL actionable content. You never lose specifics.";

function buildCompressionPrompt(
  content: string,
  budgetTokens: number
): string {
  return `Distill the following AI response into approximately ${budgetTokens} tokens.

RULES:
- PRESERVE: file paths, function/class/variable names, error messages, code blocks, URLs, commands, version numbers, configuration values, numeric data, step-by-step instructions
- PRESERVE: the response's conclusions, recommendations, and direct answers
- REMOVE: filler phrases ("Sure, I'd be happy to help", "Let me explain"), hedging ("it might be", "generally speaking"), unnecessary repetition, verbose transitions
- FORMAT: Keep markdown structure (headers, lists, code blocks). Use dense bullet points instead of paragraphs where possible
- If the response is mostly code, keep the code intact and compress only the surrounding explanation
- Do NOT add your own commentary, preamble, or meta-statements about the compression
- Output ONLY the distilled content

Response to distill:

${content}`;
}

// ---------------------------------------------------------------------------
// Main compression function
// ---------------------------------------------------------------------------

export async function compressResponse(
  provider: Provider,
  response: QueryResponse,
  maxResponseTokens: number
): Promise<CompressionResult> {
  // Check if compression is needed
  if (!shouldCompress(response, maxResponseTokens)) {
    return { content: response.content, compressed: false };
  }

  // Pick a compressor model (cheap/fast, not the worker model)
  const compressorModel = await pickCompressorModel(
    provider,
    response.model
  );
  if (!compressorModel) {
    logger.warn(
      "compress: no compressor model available, returning raw response"
    );
    return { content: response.content, compressed: false };
  }

  const originalTokens =
    response.usage?.completion_tokens ??
    Math.ceil(response.content.length / 4);

  logger.info(
    `compress: distilling ~${originalTokens} tokens to ~${maxResponseTokens} using ${compressorModel}`
  );

  try {
    const compressResult = await provider.query(
      compressorModel,
      buildCompressionPrompt(response.content, maxResponseTokens),
      {
        system_prompt: COMPRESSION_SYSTEM_PROMPT,
        temperature: 0,
        max_tokens: maxResponseTokens,
      }
    );

    const compressedTokens =
      compressResult.usage?.completion_tokens ??
      Math.ceil(compressResult.content.length / 4);

    logger.info(
      `compress: ${originalTokens} → ${compressedTokens} tokens (${Math.round((1 - compressedTokens / originalTokens) * 100)}% reduction)`
    );

    return {
      content: compressResult.content,
      compressed: true,
      compressorModel,
      compressorLatency: compressResult.latency_ms,
      originalTokens,
      compressedTokens,
      rawContent: response.content,
    };
  } catch (err) {
    logger.warn(
      `compress: compression failed, returning raw response: ${err instanceof Error ? err.message : String(err)}`
    );
    return { content: response.content, compressed: false };
  }
}
