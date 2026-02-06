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
 * How "agreement" works:
 * We use a judge model to evaluate whether responses agree semantically.
 * One of the available models gets picked as a judge (or the user can
 * specify one). The judge reads all responses and groups them by
 * agreement. This is way better than keyword matching because it
 * understands that "start with a monolith" and "monolith, it's simpler"
 * are the same answer.
 *
 * Falls back to naive keyword matching if the judge call fails.
 */

import { z } from "zod";
import { Provider } from "../providers/provider.js";
import { logger } from "../utils/logger.js";

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
  judge_model: z.string().optional().describe("Optional model ID to use as judge. Auto-picks if not specified."),
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

  // Use a judge model to determine agreement
  const judgeModel = input.judge_model ?? await pickJudge(provider, input.models);
  let agreeing: ModelVote[];
  let dissenting: ModelVote[];
  let judgeLatency: number | undefined;

  if (judgeModel) {
    logger.info(`consensus: using ${judgeModel} as judge`);
    const judgeStart = Date.now();
    const judgeResult = await judgeAgreement(provider, judgeModel, successful);
    judgeLatency = Date.now() - judgeStart;

    if (judgeResult) {
      agreeing = judgeResult.agreeing;
      dissenting = judgeResult.dissenting;
    } else {
      // Judge failed, fall back to keyword matching
      logger.warn("consensus: judge failed, falling back to keyword matching");
      ({ agreeing, dissenting } = keywordFallback(successful));
    }
  } else {
    logger.warn("consensus: no judge available, using keyword matching");
    ({ agreeing, dissenting } = keywordFallback(successful));
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
    judgeModel,
    judgeLatency,
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
 * Pick a judge model. Prefers a model not in the poll list so
 * there's no conflict of interest. Falls back to first available
 * if all models are in the poll.
 */
async function pickJudge(provider: Provider, polledModels: string[]): Promise<string | null> {
  try {
    const available = await provider.listModels();
    if (available.length === 0) return null;

    // Prefer a model that's NOT being polled
    const polledSet = new Set(polledModels.map((m) => m.toLowerCase()));
    const outside = available.find(
      (m) => !polledSet.has(m.id.toLowerCase()) && !polledSet.has(m.id.split("/").pop()?.toLowerCase() ?? "")
    );

    if (outside) return outside.id;

    // Everyone's in the poll. Just use the first available model.
    return available[0].id;
  } catch {
    return null;
  }
}

/**
 * Ask a judge model to group responses by agreement.
 * Returns the largest agreement group as "agreeing" and the rest as "dissenting".
 */
async function judgeAgreement(
  provider: Provider,
  judgeModel: string,
  votes: ModelVote[]
): Promise<{ agreeing: ModelVote[]; dissenting: ModelVote[] } | null> {
  const responseSummary = votes
    .map((v, i) => `Response ${i + 1} (${v.model}):\n${v.content}`)
    .join("\n\n---\n\n");

  const judgePrompt = `You are judging whether multiple AI model responses agree with each other.

Here are ${votes.length} responses to the same question:

${responseSummary}

Do these responses fundamentally agree on the same answer/position, even if they use different words or go into different levels of detail?

Reply with ONLY valid JSON in this exact format, no other text:
{"groups": [[0, 1, 2]], "reasoning": "all three say the same thing"}

Rules:
- Each group is an array of response numbers (0-indexed)
- Responses that agree go in the same group
- If all responses agree, put them all in one group like [[0, 1, 2]]
- If there are two camps, make two groups like [[0, 1], [2]]
- Focus on the substance of the answer, not the wording
- "reasoning" should be one short sentence`;

  try {
    const result = await provider.query(judgeModel, judgePrompt, {
      temperature: 0,
      max_tokens: 256,
    });

    // Parse the judge's JSON response
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn("consensus judge: no JSON found in response");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.groups || !Array.isArray(parsed.groups)) {
      logger.warn("consensus judge: invalid groups format");
      return null;
    }

    // Find the largest agreement group
    const groups: number[][] = parsed.groups;
    const largest = groups.reduce((a, b) => (a.length >= b.length ? a : b), []);

    const agreeing: ModelVote[] = largest.map((i: number) => votes[i]).filter(Boolean);
    const agreeingSet = new Set(largest);
    const dissenting: ModelVote[] = votes.filter((_, i) => !agreeingSet.has(i));

    logger.info(
      `consensus judge: ${agreeing.length}/${votes.length} agree. ${parsed.reasoning ?? ""}`
    );

    return { agreeing, dissenting };
  } catch (err) {
    logger.warn(`consensus judge failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Keyword-based fallback when no judge model is available.
 * Naive but better than nothing.
 */
function keywordFallback(votes: ModelVote[]): { agreeing: ModelVote[]; dissenting: ModelVote[] } {
  const baseline = votes[0];
  const agreeing = [baseline];
  const dissenting: ModelVote[] = [];

  for (let i = 1; i < votes.length; i++) {
    if (responsesAgreeByKeywords(baseline.content, votes[i].content)) {
      agreeing.push(votes[i]);
    } else {
      dissenting.push(votes[i]);
    }
  }

  return { agreeing, dissenting };
}

function responsesAgreeByKeywords(a: string, b: string): boolean {
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
  judgeModel?: string | null;
  judgeLatency?: number;
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
    result.judgeModel
      ? `**Judge:** ${result.judgeModel}${result.judgeLatency ? ` (${result.judgeLatency}ms)` : ""}`
      : "",
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

  // Show what each model actually said so the judge can be sanity-checked
  const allVotes = [...result.agreeing, ...result.dissenting];
  if (allVotes.length > 1) {
    lines.push("### Individual Responses");
    for (const v of allVotes) {
      const summary = v.content.slice(0, 150).replace(/\n/g, " ");
      lines.push(`- **${v.model}:** ${summary}${v.content.length > 150 ? "..." : ""}`);
    }
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
