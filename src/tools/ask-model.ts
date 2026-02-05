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
 * - We return structured metadata (latency, tokens) so Claude Code
 *   can reason about cost/performance
 */

import { z } from "zod";
import { Provider, QueryResponse } from "../providers/provider.js";

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
  format: z
    .enum(["brief", "detailed"])
    .optional()
    .default("detailed")
    .describe("Response format — 'brief' for token-efficient summary, 'detailed' for full response"),
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

  return formatResponse(response, input.format ?? "detailed");
}

function formatResponse(response: QueryResponse, format: "brief" | "detailed"): string {
  if (format === "brief") {
    return [
      `**${response.model}** (${response.latency_ms}ms)`,
      "",
      response.content,
    ].join("\n");
  }

  const lines = [
    `## Response from ${response.model}`,
    "",
    response.content,
    "",
    "---",
    `**Latency:** ${response.latency_ms}ms`,
  ];

  if (response.usage) {
    lines.push(
      `**Tokens:** ${response.usage.prompt_tokens} in → ${response.usage.completion_tokens} out (${response.usage.total_tokens} total)`
    );
  }

  if (response.finish_reason && response.finish_reason !== "stop") {
    lines.push(`**Note:** Response ended due to: ${response.finish_reason}`);
  }

  return lines.join("\n");
}
