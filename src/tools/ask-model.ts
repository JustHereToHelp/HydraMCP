/**
 * ask_model — Query any single model through HydraMCP.
 *
 * This is the foundational tool. Everything else (compare, consensus)
 * builds on top of this. Keep it simple, keep it reliable.
 *
 * Design decisions:
 * - format: "brief" | "detailed" controls response verbosity
 *   to keep Claude Code's context window lean
 * - max_tokens defaults to 1024 (not unlimited) to prevent
 *   runaway responses from eating context
 * - max_response_tokens enables distillation — a cheap/fast model
 *   compresses the response before it reaches Claude's context window
 * - We return structured metadata (latency, tokens) so Claude Code
 *   can reason about cost/performance
 */

import { z } from "zod";
import { Provider, QueryResponse } from "../providers/provider.js";
import {
  compressResponse,
  CompressionResult,
} from "../utils/compress.js";

export const askModelSchema = z.object({
  model: z.string().describe("Model ID to query (e.g. 'gpt-4o', 'gemini-2.5-pro')"),
  prompt: z.string().describe("The prompt to send to the model"),
  system_prompt: z
    .string()
    .optional()
    .describe("Optional system prompt to set model behavior"),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Sampling temperature (0 = deterministic, 2 = creative)"),
  max_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1024)
    .describe("Maximum tokens in response (default: 1024)"),
  max_response_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum tokens in the response returned to you. If the model's response exceeds this, " +
      "it will be distilled by a fast model to fit — preserving code, file paths, errors, " +
      "and actionable details while stripping filler. Omit for no compression."
    ),
  format: z
    .enum(["brief", "detailed"])
    .optional()
    .default("detailed")
    .describe(
      "Response format — 'brief' for token-efficient summary, 'detailed' for full response"
    ),
});

export type AskModelInput = z.infer<typeof askModelSchema>;

export async function askModel(
  provider: Provider,
  input: AskModelInput
): Promise<string> {
  const response = await provider.query(input.model, input.prompt, {
    system_prompt: input.system_prompt,
    temperature: input.temperature,
    max_tokens: input.max_tokens,
  });

  // Compress if max_response_tokens is set
  let compression: CompressionResult | undefined;
  if (input.max_response_tokens) {
    compression = await compressResponse(
      provider,
      response,
      input.max_response_tokens
    );
  }

  return formatResponse(response, input.format ?? "detailed", compression);
}

function formatResponse(
  response: QueryResponse,
  format: "brief" | "detailed",
  compression?: CompressionResult
): string {
  const content = compression?.content ?? response.content;

  if (format === "brief") {
    const lines = [
      `**${response.model}** (${response.latency_ms}ms)`,
      "",
      content,
    ];
    if (compression?.compressed) {
      lines.push("");
      lines.push(
        `*Distilled by ${compression.compressorModel} (${compression.compressorLatency}ms)*`
      );
    }
    return lines.join("\n");
  }

  const lines = [
    `## Response from ${response.model}`,
    "",
    content,
    "",
    "---",
    `**Latency:** ${response.latency_ms}ms`,
  ];

  if (response.usage) {
    lines.push(
      `**Tokens:** ${response.usage.prompt_tokens} in → ${response.usage.completion_tokens} out (${response.usage.total_tokens} total)`
    );
  }

  if (compression?.compressed) {
    lines.push(
      `**Distilled:** ${compression.originalTokens ?? "?"} → ${compression.compressedTokens ?? "?"} tokens by ${compression.compressorModel} (${compression.compressorLatency}ms)`
    );
  }

  if (response.finish_reason && response.finish_reason !== "stop") {
    lines.push(`**Note:** Response ended due to: ${response.finish_reason}`);
  }

  return lines.join("\n");
}
