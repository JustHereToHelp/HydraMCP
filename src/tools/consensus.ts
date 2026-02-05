/**
 * consensus — Ask multiple models, aggregate into a single answer.
 *
 * This is the "I need confidence" tool. Instead of getting 5 opinions
 * and reading them all, you get one answer with a confidence score.
 *
 * Strategy options:
 * - majority:     >50% of models agree
 * - supermajority: >=66% agree (for higher confidence)
 * - unanimous:     100% agree (for critical decisions)
 *
 * How "agreement" works (for now):
 * We use a simple approach — send each model's response to the provider
 * and ask it to categorize them. This is v1. We can get fancier later
 * with embeddings or semantic similarity, but let's see if the basic
 * version is useful first.
 *
 * For the skeleton, we do simple string-based grouping that we'll
 * improve once we test with real responses.
 */

import { z } from "zod";
import { Provider } from "../providers/provider.js";

export const consensusSchema = z.object({
  models: z
    .array(z.string())
    .min(3)
    .max(7)
    .describe("List of model IDs to poll (3-7 models)"),
  prompt: z.string().describe("The prompt to send to all models"),
  strategy: z
    .enum(["majority", "supermajority", "unanimous"])
    .optional()
    .default("majority")
    .describe("Voting strategy — how many models must agree"),
  system_prompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional().default(0),
  max_tokens: z.number().int().positive().optional().default(1024),
});

export type ConsensusInput = z.infer<typeof consensusSchema>;

interface ModelVote {
  model: string;
  content: string;
  error?: string;
}

export async function consensus(
  provider: Provider,
  input: ConsensusInput
): Promise<string> {
  // Query all models in parallel
  const results = await Promise.allSettled(
    input.models.map((model) =>
      provider.query(model, input.prompt, {
        system_prompt: input.system_prompt,
        temperature: input.temperature,
        max_tokens: input.max_tokens,
      })
    )
  );

  const votes: ModelVote[] = results.map((result, i) => {
    if (result.status === "fulfilled") {
      return { model: input.models[i], content: result.value.content };
    }
    return {
      model: input.models[i],
      content: "",
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    };
  });

  const successful = votes.filter((v) => !v.error);
  const failed = votes.filter((v) => v.error);

  if (successful.length < 2) {
    return `## Consensus Failed\n\nOnly ${successful.length} model(s) responded. Need at least 2 for consensus.\n\nErrors:\n${failed.map((f) => `- ${f.model}: ${f.error}`).join("\n")}`;
  }

  const threshold = getThreshold(input.strategy ?? "majority");
  const requiredVotes = Math.ceil(successful.length * threshold);

  // v1: Simple first-response-as-baseline grouping
  // We pick the first response as the "baseline" and check if others
  // agree directionally. This is intentionally naive — we'll improve
  // with real usage data.
  const baseline = successful[0];
  const agreeing = [baseline];
  const dissenting: ModelVote[] = [];

  for (let i = 1; i < successful.length; i++) {
    // Simple heuristic: responses under a length ratio threshold
    // and sharing key terms are considered "agreeing"
    // This WILL be replaced with better similarity logic
    if (responsesAgree(baseline.content, successful[i].content)) {
      agreeing.push(successful[i]);
    } else {
      dissenting.push(successful[i]);
    }
  }

  const reached = agreeing.length >= requiredVotes;

  return formatConsensus({
    reached,
    strategy: input.strategy ?? "majority",
    agreeing,
    dissenting,
    failed,
    requiredVotes,
    totalVoters: successful.length,
  });
}

function getThreshold(strategy: "majority" | "supermajority" | "unanimous"): number {
  switch (strategy) {
    case "majority":
      return 0.5;
    case "supermajority":
      return 0.66;
    case "unanimous":
      return 1.0;
  }
}

/**
 * Naive agreement check — v1 placeholder.
 * Checks if two responses share enough key words to be considered
 * "saying the same thing." This will be replaced with something
 * smarter once we see real response patterns.
 */
function responsesAgree(a: string, b: string): boolean {
  const wordsA = new Set(
    a.toLowerCase().split(/\s+/).filter((w) => w.length > 4)
  );
  const wordsB = new Set(
    b.toLowerCase().split(/\s+/).filter((w) => w.length > 4)
  );

  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  const similarity = overlap / Math.max(wordsA.size, wordsB.size);
  return similarity > 0.3;
}

interface ConsensusResult {
  reached: boolean;
  strategy: string;
  agreeing: ModelVote[];
  dissenting: ModelVote[];
  failed: ModelVote[];
  requiredVotes: number;
  totalVoters: number;
}

function formatConsensus(result: ConsensusResult): string {
  const confidence = Math.round(
    (result.agreeing.length / result.totalVoters) * 100
  );

  const lines: string[] = [
    `## Consensus: ${result.reached ? "REACHED" : "NOT REACHED"}`,
    "",
    `**Strategy:** ${result.strategy} (needed ${result.requiredVotes}/${result.totalVoters})`,
    `**Agreement:** ${result.agreeing.length}/${result.totalVoters} models (${confidence}%)`,
    "",
  ];

  // Show the consensus answer (first agreeing model's response)
  if (result.agreeing.length > 0) {
    lines.push("### Consensus Response");
    lines.push("");
    lines.push(result.agreeing[0].content);
    lines.push("");
    lines.push(
      `*Agreed by: ${result.agreeing.map((v) => v.model).join(", ")}*`
    );
    lines.push("");
  }

  // Show dissent
  if (result.dissenting.length > 0) {
    lines.push("### Dissenting Views");
    for (const d of result.dissenting) {
      lines.push(`- **${d.model}:** ${d.content.slice(0, 200)}${d.content.length > 200 ? "..." : ""}`);
    }
    lines.push("");
  }

  // Show failures
  if (result.failed.length > 0) {
    lines.push(`*${result.failed.length} model(s) failed to respond*`);
  }

  return lines.join("\n");
}
