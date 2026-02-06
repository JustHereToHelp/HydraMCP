/**
 * compare_models — Query multiple models in parallel, return side-by-side.
 *
 * This is where HydraMCP gets interesting. Instead of asking one model,
 * you fan out to 2-5 models and get a structured comparison back.
 *
 * Key design: we return a TABLE, not 5 full responses. Claude Code
 * can always follow up with ask_model for the full response from
 * any specific model. This keeps context window usage sane.
 *
 * Graceful degradation: if 1 of 5 models fails, we return 4 results
 * plus an error note. We never fail the whole comparison because
 * one model had a bad day.
 */

import { z } from "zod";
import { Provider, QueryResponse } from "../providers/provider.js";

export const compareModelsSchema = z.object({
  models: z
    .array(z.string())
    .min(2)
    .max(5)
    .describe("List of model IDs to compare (2-5 models)"),
  prompt: z.string().describe("The prompt to send to all models"),
  system_prompt: z.string().optional().describe("Optional system prompt for all models"),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional().default(1024),
});

export type CompareModelsInput = z.infer<typeof compareModelsSchema>;

interface CompareResult {
  model: string;
  content: string;
  latency_ms: number;
  tokens?: number;
  error?: string;
}

export async function compareModels(
  provider: Provider,
  input: CompareModelsInput
): Promise<string> {
  const startTime = Date.now();

  // Fan out to all models in parallel
  const results = await Promise.allSettled(
    input.models.map((model) =>
      provider.query(model, input.prompt, {
        system_prompt: input.system_prompt,
        temperature: input.temperature,
        max_tokens: input.max_tokens,
      })
    )
  );

  // Collect results, including failures
  const compared: CompareResult[] = results.map((result, i) => {
    if (result.status === "fulfilled") {
      return {
        model: input.models[i],
        content: result.value.content,
        latency_ms: result.value.latency_ms,
        tokens: result.value.usage?.total_tokens,
      };
    } else {
      return {
        model: input.models[i],
        content: "",
        latency_ms: 0,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    }
  });

  const totalTime = Date.now() - startTime;
  return formatComparison(compared, totalTime);
}

function formatComparison(results: CompareResult[], totalTime: number): string {
  const successful = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  const lines: string[] = [
    `## Model Comparison (${results.length} models, ${totalTime}ms total)`,
    "",
  ];

  // Summary table
  if (successful.length > 0) {
    const fastest = successful.reduce((a, b) =>
      a.latency_ms < b.latency_ms ? a : b
    );

    lines.push("| Model | Latency | Tokens |");
    lines.push("|-------|---------|--------|");
    for (const r of successful) {
      const badge = r.model === fastest.model ? " fastest" : "";
      lines.push(
        `| ${r.model} | ${r.latency_ms}ms${badge} | ${r.tokens ?? "n/a"} |`
      );
    }
    lines.push("");
  }

  // Each model's response
  for (const r of successful) {
    lines.push(`### ${r.model}`);
    lines.push("");
    lines.push(r.content);
    lines.push("");
  }

  // Failures
  if (failed.length > 0) {
    lines.push("### Errors");
    for (const r of failed) {
      lines.push(`- **${r.model}:** ${r.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
