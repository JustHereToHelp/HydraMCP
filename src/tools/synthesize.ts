/**
 * synthesize — Fan out to multiple models, then combine their best ideas
 * into one answer that's better than any single model could produce.
 *
 * This is the power user tool. compare_models shows you side by side.
 * consensus tells you if they agree. synthesize actually merges their
 * strengths into one combined response.
 *
 * How it works:
 * 1. Send the prompt to 2-5 models in parallel (same as compare_models)
 * 2. Collect all responses
 * 3. Send everything to a synthesizer model with instructions to combine
 *    the best parts: best structure, best insights, best examples
 * 4. Return one merged answer plus metadata about what came from where
 *
 * The synthesizer model is auto-picked (or user-specified). It reads
 * all responses and builds something better than any individual one.
 */

import { z } from "zod";
import { Provider } from "../providers/provider.js";
import { logger } from "../utils/logger.js";

export const synthesizeSchema = z.object({
  models: z
    .array(z.string())
    .min(2)
    .max(5)
    .describe("List of model IDs to synthesize from (2-5 models)"),
  prompt: z.string().describe("The prompt to send to all models"),
  synthesizer_model: z
    .string()
    .optional()
    .describe("Optional model ID to use as synthesizer. Auto-picks if not specified."),
  system_prompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional().default(1024),
});

export type SynthesizeInput = z.infer<typeof synthesizeSchema>;

interface ModelResponse {
  model: string;
  content: string;
  latency_ms: number;
  tokens?: number;
  error?: string;
}

export async function synthesize(
  provider: Provider,
  input: SynthesizeInput
): Promise<string> {
  const startTime = Date.now();

  // Step 1: Fan out to all models in parallel
  const results = await Promise.allSettled(
    input.models.map((model) =>
      provider.query(model, input.prompt, {
        system_prompt: input.system_prompt,
        temperature: input.temperature,
        max_tokens: input.max_tokens,
      })
    )
  );

  const responses: ModelResponse[] = results.map((result, i) => {
    if (result.status === "fulfilled") {
      return {
        model: input.models[i],
        content: result.value.content,
        latency_ms: result.value.latency_ms,
        tokens: result.value.usage?.total_tokens,
      };
    }
    return {
      model: input.models[i],
      content: "",
      latency_ms: 0,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    };
  });

  const successful = responses.filter((r) => !r.error);
  const failed = responses.filter((r) => r.error);

  if (successful.length < 2) {
    return `## Synthesis Failed\n\nOnly ${successful.length} model(s) responded. Need at least 2 for synthesis.\n\nErrors:\n${failed.map((f) => `- ${f.model}: ${f.error}`).join("\n")}`;
  }

  // Step 2: Pick a synthesizer model
  const synthModel = input.synthesizer_model ?? await pickSynthesizer(provider, input.models);

  if (!synthModel) {
    return formatWithoutSynthesis(successful, failed, Date.now() - startTime);
  }

  // Step 3: Send all responses to the synthesizer
  logger.info(`synthesize: using ${synthModel} as synthesizer`);
  const synthStart = Date.now();

  const responseSummary = successful
    .map((r) => `## ${r.model}\n${r.content}`)
    .join("\n\n---\n\n");

  const synthPrompt = `You are combining ${successful.length} AI model responses into one final answer.

Question: "${input.prompt}"

Responses:

${responseSummary}

Write ONE definitive answer. Take the best insights from each, drop the filler. Do not reference the models, do not say "one model suggested." Just give the answer as if you're the expert who considered all perspectives.

Keep it shorter than the longest individual response. No preamble, no "here's the synthesis." Just the answer.`;

  try {
    const synthResult = await provider.query(synthModel, synthPrompt, {
      temperature: input.temperature ?? 0.3,
      max_tokens: input.max_tokens,
    });

    const synthLatency = Date.now() - synthStart;
    const totalTime = Date.now() - startTime;

    return formatSynthesis({
      synthesized: synthResult.content,
      synthModel,
      synthLatency,
      sources: successful,
      failed,
      totalTime,
    });
  } catch (err) {
    logger.warn(`synthesizer failed: ${err instanceof Error ? err.message : String(err)}`);
    return formatWithoutSynthesis(successful, failed, Date.now() - startTime);
  }
}

/**
 * Pick a synthesizer model. Same logic as consensus judge -
 * prefer a model not in the source list.
 */
async function pickSynthesizer(provider: Provider, sourceModels: string[]): Promise<string | null> {
  try {
    const available = await provider.listModels();
    if (available.length === 0) return null;

    const sourceSet = new Set(sourceModels.map((m) => m.toLowerCase()));
    const outside = available.find(
      (m) => !sourceSet.has(m.id.toLowerCase()) && !sourceSet.has(m.id.split("/").pop()?.toLowerCase() ?? "")
    );

    if (outside) return outside.id;
    return available[0].id;
  } catch {
    return null;
  }
}

interface SynthesisResult {
  synthesized: string;
  synthModel: string;
  synthLatency: number;
  sources: ModelResponse[];
  failed: ModelResponse[];
  totalTime: number;
}

function formatSynthesis(result: SynthesisResult): string {
  const lines: string[] = [
    `## Synthesized Response (${result.sources.length} models, ${result.totalTime}ms total)`,
    "",
    `**Synthesizer:** ${result.synthModel} (${result.synthLatency}ms)`,
    `**Sources:** ${result.sources.map((s) => s.model).join(", ")}`,
    "",
    result.synthesized,
    "",
  ];

  // Source summary table
  lines.push("### Source Metrics");
  lines.push("");
  lines.push("| Model | Latency | Tokens |");
  lines.push("|-------|---------|--------|");
  for (const s of result.sources) {
    lines.push(`| ${s.model} | ${s.latency_ms}ms | ${s.tokens ?? "n/a"} |`);
  }
  lines.push("");

  if (result.failed.length > 0) {
    lines.push("### Errors");
    for (const f of result.failed) {
      lines.push(`- **${f.model}:** ${f.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Fallback if no synthesizer is available - just return
 * all responses like compare_models would.
 */
function formatWithoutSynthesis(
  successful: ModelResponse[],
  failed: ModelResponse[],
  totalTime: number
): string {
  const lines: string[] = [
    `## Synthesis Failed - Showing Raw Responses (${totalTime}ms total)`,
    "",
    "*No synthesizer model available. Showing individual responses instead.*",
    "",
  ];

  for (const r of successful) {
    lines.push(`### ${r.model}`);
    lines.push("");
    lines.push(r.content);
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("### Errors");
    for (const f of failed) {
      lines.push(`- **${f.model}:** ${f.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
