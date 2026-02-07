/**
 * session-recap — Two-pass session recap using a large-context model.
 *
 * Reads previous Claude Code sessions from disk (server-side), sends them
 * to a large-context model like Gemini, and returns a smart-sized summary.
 * Claude never sees the raw session data — only the distilled recap.
 *
 * How it works:
 * 1. Read N recent session JSONL files from ~/.claude/projects/
 * 2. Parse & filter (keep meaningful content, strip noise + secrets)
 * 3. PASS 1: Send to model — "triage this, return event counts as JSON"
 * 4. Calculate summary budget from triage results
 * 5. PASS 2: Send to model — "write a recap in {budget} tokens"
 * 6. Return only the recap to Claude
 */

import { z } from "zod";
import { Provider } from "../providers/provider.js";
import { logger } from "../utils/logger.js";
import {
  readSessions,
  formatSessionsForPrompt,
  type SessionBundle,
} from "../utils/session-reader.js";
import { pickLargeContextModel } from "../utils/model-selection.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const sessionRecapSchema = z.object({
  sessions: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(3)
    .describe("Number of recent sessions to recap (default: 3)"),
  project: z
    .string()
    .optional()
    .describe(
      "Project path to recap, e.g. 'C:\\\\Users\\\\Beast\\\\Documents\\\\GitHub\\\\MyProject'. Auto-detects most recent project if omitted."
    ),
  focus: z
    .string()
    .optional()
    .describe(
      "Optional focus area to filter both triage and recap, e.g. 'auth implementation' or 'database migration'. When set, only events related to this topic are counted and summarized."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model to use for recap. Should be a large-context model like Gemini. Auto-picks if omitted."
    ),
  max_summary_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Override the auto-calculated summary budget (in tokens). Auto-calculation ranges from 1K to 30K based on session density."),
});

export type SessionRecapInput = z.infer<typeof sessionRecapSchema>;

// ---------------------------------------------------------------------------
// Triage types
// ---------------------------------------------------------------------------

interface TriageItem {
  summary: string;
  importance?: string;
  status?: string;
  priority?: string;
}

interface TriageResult {
  files_modified: string[];
  decisions_made: TriageItem[];
  errors_resolved: TriageItem[];
  features_built: TriageItem[];
  unfinished_work: TriageItem[];
  total_meaningful_events: number;
}

// ---------------------------------------------------------------------------
// Pass 1: Triage
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM_PROMPT = `You are a precise code session analyzer. You read Claude Code conversation transcripts and extract structured metadata. Return ONLY valid JSON, no markdown, no explanation.`;

function buildTriagePrompt(sessionText: string, focus?: string): string {
  const focusInstruction = focus
    ? `\n**FOCUS FILTER:** Only count events, files, decisions, and work related to: "${focus}". Ignore everything unrelated to this topic.\n`
    : "";

  return `Analyze these Claude Code session transcripts and return ONLY valid JSON with this exact structure:

{
  "files_modified": ["src/auth.ts", "src/db.ts"],
  "decisions_made": [{"summary": "Chose JWT over sessions for auth", "importance": "high"}],
  "errors_resolved": [{"summary": "Fixed auth redirect loop in middleware", "importance": "medium"}],
  "features_built": [{"summary": "User login flow with email verification", "status": "complete"}],
  "unfinished_work": [{"summary": "Database migration script for v2 schema", "priority": "high"}],
  "total_meaningful_events": 15
}

Rules:
- Count only substantive events. Greetings, small talk, and meta-questions are NOT events.
- A file being created/modified, a bug fixed, an architecture decision, a feature implemented — those ARE events.
- For files_modified, list unique file paths mentioned in tool calls or discussions.
- Importance/priority: "high", "medium", or "low".
- Status: "complete", "partial", or "planned".
${focusInstruction}
Session transcripts:

${sessionText}`;
}

function parseTriage(response: string): TriageResult | null {
  try {
    // Extract JSON from response (handle any preamble/postamble)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      files_modified: Array.isArray(parsed.files_modified)
        ? parsed.files_modified
        : [],
      decisions_made: Array.isArray(parsed.decisions_made)
        ? parsed.decisions_made
        : [],
      errors_resolved: Array.isArray(parsed.errors_resolved)
        ? parsed.errors_resolved
        : [],
      features_built: Array.isArray(parsed.features_built)
        ? parsed.features_built
        : [],
      unfinished_work: Array.isArray(parsed.unfinished_work)
        ? parsed.unfinished_work
        : [],
      total_meaningful_events:
        typeof parsed.total_meaningful_events === "number"
          ? parsed.total_meaningful_events
          : 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Budget calculation
// ---------------------------------------------------------------------------

function calculateBudget(
  triage: TriageResult,
  totalInputChars: number,
  sessionCount: number
): number {
  const inputTokens = Math.ceil(totalInputChars / 4);
  const eventCount = triage.total_meaningful_events;

  // Base: 4% of input tokens
  const baseSummary = inputTokens * 0.04;

  // Density factor: more events → bigger summary (0.5x to 2.0x)
  const densityFactor = Math.max(0.5, Math.min(2.0, eventCount / 20));
  let adjusted = baseSummary * densityFactor;

  // Multi-session bonus: 30% more per additional session
  adjusted *= 1 + (sessionCount - 1) * 0.3;

  // Clamp to reasonable bounds
  const MIN = 1000;
  const MAX = 30000;
  return Math.max(MIN, Math.min(MAX, Math.round(adjusted)));
}

function calculateWeights(
  triage: TriageResult
): Record<string, number> {
  const counts: Record<string, number> = {
    files: triage.files_modified.length,
    decisions: triage.decisions_made.length,
    features: triage.features_built.length,
    errors: triage.errors_resolved.length,
    unfinished: triage.unfinished_work.length,
  };

  const total =
    Object.values(counts).reduce((a, b) => a + b, 0) || 1;

  // Each section gets proportional weight, minimum 10% each
  const weights: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    weights[key] = Math.max(10, Math.round((count / total) * 100));
  }
  return weights;
}

// ---------------------------------------------------------------------------
// Pass 2: Recap
// ---------------------------------------------------------------------------

const RECAP_SYSTEM_PROMPT = `You are a developer context reconstructor. You read Claude Code session transcripts and produce structured, actionable recaps that let a developer resume work immediately. Be specific — include file paths, function names, error messages. No filler.`;

function buildRecapPrompt(
  sessionText: string,
  triage: TriageResult,
  budget: number,
  sessionCount: number,
  focus?: string
): string {
  const weights = calculateWeights(triage);

  const focusInstruction = focus
    ? `\n**FOCUS AREA:** The developer specifically wants to know about: "${focus}". Prioritize information related to this topic.\n`
    : "";

  return `You are creating a session recap for a developer starting a new Claude Code session.
They need to understand what happened in their previous ${sessionCount} session(s) without reading the raw transcripts.

Your budget: approximately ${budget} tokens. Use it wisely — be dense, not verbose.
${focusInstruction}
Write a structured recap with these sections. Allocate space proportionally:
- ~${weights.files}% for **File Map** (${triage.files_modified.length} files detected)
- ~${weights.decisions}% for **Key Decisions** (${triage.decisions_made.length} decisions detected)
- ~${weights.features}% for **What Was Built** (${triage.features_built.length} features detected)
- ~${weights.errors}% for **Errors Resolved** (${triage.errors_resolved.length} errors detected)
- ~${weights.unfinished}% for **Unfinished / In Progress** (${triage.unfinished_work.length} items detected)

Required format:

## Project State
Current branch, key files, what's working. One paragraph max.

## What Was Built
- Feature: status, key files involved

## Key Decisions
- Decision: reasoning in one sentence

## Errors Resolved
- Error: how it was fixed, in which file

## Unfinished / In Progress
- Item: last known state, what's needed next

## File Map
- path — one-line description of what changed

Omit any section that has zero items. Be specific. Include file paths, function names, error messages. The developer needs actionable context, not vague summaries.

Session transcripts:

${sessionText}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function sessionRecap(
  provider: Provider,
  input: SessionRecapInput
): Promise<string> {
  const startTime = Date.now();

  // Step 1: Read sessions from disk
  logger.info(
    `session_recap: reading ${input.sessions} sessions${input.project ? ` for ${input.project}` : " (auto-detect)"}`
  );

  let bundle: SessionBundle;
  try {
    bundle = readSessions(input.project, input.sessions);
  } catch (err) {
    return `## Session Recap Failed\n\n${err instanceof Error ? err.message : String(err)}\n\n**Recovery:** If the project was not found, retry with an explicit project path. Run session_recap with the project parameter set to one of the available projects listed above.`;
  }

  if (bundle.sessions.length === 0) {
    return "## Session Recap Failed\n\nNo sessions found to recap. The project directory exists but contains no .jsonl session files.\n\n**Recovery:** Try a different project path, or increase the sessions count. If the user recently started using Claude Code on this project, there may not be any history yet.";
  }

  const sessionText = formatSessionsForPrompt(bundle);
  logger.info(
    `session_recap: ${bundle.sessionCount} sessions, ${bundle.totalChars} chars`
  );

  // Step 2: Pick a model
  const model = await pickLargeContextModel(provider, input.model);
  if (!model) {
    return "## Session Recap Failed\n\nNo models available for summarization.\n\n**Recovery:** The user needs to start a model provider. Tell them to start CLIProxyAPI or Ollama, then retry. You can also verify provider status by calling list_models first.";
  }

  logger.info(`session_recap: using model ${model}`);

  // Step 3: Pass 1 — Triage
  const triageStart = Date.now();
  let triage: TriageResult | null = null;

  try {
    const triageResult = await provider.query(
      model,
      buildTriagePrompt(sessionText, input.focus),
      {
        system_prompt: TRIAGE_SYSTEM_PROMPT,
        temperature: 0,
        max_tokens: 1024,
      }
    );
    triage = parseTriage(triageResult.content);
  } catch (err) {
    logger.warn(
      `session_recap: triage failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const triageMs = Date.now() - triageStart;

  // Step 4: Calculate budget
  let budget: number;
  if (input.max_summary_tokens) {
    budget = input.max_summary_tokens;
  } else if (triage) {
    budget = calculateBudget(
      triage,
      bundle.totalChars,
      bundle.sessionCount
    );
  } else {
    // Fallback: fixed budget if triage failed
    budget = 5000;
    logger.warn("session_recap: using fallback budget of 5000 tokens");
  }

  // Use a default triage if pass 1 failed
  const effectiveTriage: TriageResult = triage ?? {
    files_modified: [],
    decisions_made: [],
    errors_resolved: [],
    features_built: [],
    unfinished_work: [],
    total_meaningful_events: 0,
  };

  logger.info(
    `session_recap: budget=${budget} tokens, events=${effectiveTriage.total_meaningful_events}`
  );

  // Step 5: Pass 2 — Full recap
  const recapStart = Date.now();

  try {
    const recapResult = await provider.query(
      model,
      buildRecapPrompt(
        sessionText,
        effectiveTriage,
        budget,
        bundle.sessionCount,
        input.focus
      ),
      {
        system_prompt: RECAP_SYSTEM_PROMPT,
        temperature: 0.2,
        max_tokens: budget,
      }
    );

    const recapMs = Date.now() - recapStart;
    const totalMs = Date.now() - startTime;

    // Format date range
    const firstSession = bundle.sessions[bundle.sessions.length - 1];
    const lastSession = bundle.sessions[0];
    const dateRange = `${firstSession?.startTime?.slice(0, 10) ?? "?"} to ${lastSession?.endTime?.slice(0, 10) ?? "?"}`;

    const lines: string[] = [
      `## Session Recap (${bundle.sessionCount} session${bundle.sessionCount > 1 ? "s" : ""}, ${bundle.projectPath})`,
      "",
      `**Model:** ${model} | **Sessions:** ${dateRange} | **Budget:** ${budget} tokens`,
      "",
      recapResult.content,
      "",
      "---",
      `*Recap generated by HydraMCP session_recap | Triage: ${triageMs}ms | Recap: ${recapMs}ms | Total: ${totalMs}ms*`,
    ];

    return lines.join("\n");
  } catch (err) {
    // Graceful degradation: return triage results as basic summary
    logger.error(
      `session_recap: recap pass failed: ${err instanceof Error ? err.message : String(err)}`
    );

    if (triage) {
      return formatTriageFallback(triage, bundle, model);
    }

    return `## Session Recap Failed\n\nBoth triage and recap passes failed. Error: ${err instanceof Error ? err.message : String(err)}\n\n**Recovery:** Retry with fewer sessions (sessions=1) to reduce input size, or specify a different model. If the error mentions a timeout or rate limit, wait a moment and retry.`;
  }
}

// ---------------------------------------------------------------------------
// Fallback formatter (when Pass 2 fails but triage succeeded)
// ---------------------------------------------------------------------------

function formatTriageFallback(
  triage: TriageResult,
  bundle: SessionBundle,
  model: string
): string {
  const lines: string[] = [
    `## Session Recap — Triage Only (${bundle.sessionCount} sessions, ${bundle.projectPath})`,
    "",
    `*Full recap failed. Showing triage data from Pass 1.*`,
    "",
    `**Model:** ${model}`,
    "",
  ];

  if (triage.features_built.length > 0) {
    lines.push("### What Was Built");
    for (const f of triage.features_built) {
      lines.push(`- ${f.summary} (${f.status ?? "unknown"})`);
    }
    lines.push("");
  }

  if (triage.decisions_made.length > 0) {
    lines.push("### Key Decisions");
    for (const d of triage.decisions_made) {
      lines.push(`- ${d.summary} [${d.importance ?? "?"}]`);
    }
    lines.push("");
  }

  if (triage.errors_resolved.length > 0) {
    lines.push("### Errors Resolved");
    for (const e of triage.errors_resolved) {
      lines.push(`- ${e.summary}`);
    }
    lines.push("");
  }

  if (triage.unfinished_work.length > 0) {
    lines.push("### Unfinished Work");
    for (const u of triage.unfinished_work) {
      lines.push(`- ${u.summary} [${u.priority ?? "?"}]`);
    }
    lines.push("");
  }

  if (triage.files_modified.length > 0) {
    lines.push("### Files Modified");
    for (const f of triage.files_modified) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  lines.push(
    `*Events detected: ${triage.total_meaningful_events}*`
  );

  return lines.join("\n");
}
