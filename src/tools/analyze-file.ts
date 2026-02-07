/**
 * analyze_file — Offload file analysis to a worker model.
 *
 * Claude sends a file path + question. The server reads the file
 * (server-side — Claude never sees the raw content), sends it to a
 * large-context model, optionally compresses the result, and returns
 * a concise answer. Zero context tokens burned on file content.
 *
 * The "Context saved" metric shows exactly how many tokens Claude
 * avoided by not reading the file itself.
 */

import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Provider, QueryResponse } from "../providers/provider.js";
import { pickLargeContextModel } from "../utils/model-selection.js";
import {
  compressResponse,
  CompressionResult,
} from "../utils/compress.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const analyzeFileSchema = z.object({
  file_path: z
    .string()
    .describe(
      "Absolute path to the file to analyze. The file is read server-side — it never enters your context window."
    ),
  prompt: z
    .string()
    .describe(
      "What to analyze, find, or review in the file. Be specific for better results."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model to use for analysis. Auto-picks a large-context model (Gemini 1M) if omitted."
    ),
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
  max_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1024)
    .describe("Maximum tokens the analysis model generates (default: 1024)"),
  format: z
    .enum(["brief", "detailed"])
    .optional()
    .default("detailed")
    .describe(
      "Response format — 'brief' for token-efficient summary, 'detailed' for full response"
    ),
  include_raw: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true and compression is active, include the original uncompressed response " +
      "for quality comparison. Use this to verify distillation preserved critical details."
    ),
});

export type AnalyzeFileInput = z.infer<typeof analyzeFileSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max file size in characters (~800K for Gemini headroom within 1M context). */
const MAX_FILE_CHARS = 800_000;

/** Binary file detection: check for null bytes in the first 8KB. */
const BINARY_CHECK_BYTES = 8192;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isBinaryFile(filePath: string): boolean {
  try {
    const fd = require("node:fs").openSync(filePath, "r");
    const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
    const bytesRead = require("node:fs").readSync(fd, buffer, 0, BINARY_CHECK_BYTES, 0);
    require("node:fs").closeSync(fd);

    // Check for null bytes — strong indicator of binary content
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function analyzeFile(
  provider: Provider,
  input: AnalyzeFileInput
): Promise<string> {
  const startTime = Date.now();

  // Step 1: Validate file exists
  if (!existsSync(input.file_path)) {
    return (
      `## Analysis Failed\n\n` +
      `File not found: \`${input.file_path}\`\n\n` +
      `**Recovery:** Check the file path. Use an absolute path.`
    );
  }

  // Step 2: Check for binary files
  if (isBinaryFile(input.file_path)) {
    return (
      `## Analysis Failed\n\n` +
      `Binary file detected: \`${input.file_path}\`\n\n` +
      `**Recovery:** This appears to be a binary file. Only text files are supported.`
    );
  }

  // Step 3: Read the file server-side
  let fileContent: string;
  try {
    fileContent = readFileSync(input.file_path, "utf-8");
  } catch (err) {
    return (
      `## Analysis Failed\n\n` +
      `Could not read file: \`${input.file_path}\`\n` +
      `Error: ${err instanceof Error ? err.message : String(err)}\n\n` +
      `**Recovery:** Check file permissions and ensure the path is correct.`
    );
  }

  // Step 4: Check file size
  if (fileContent.length > MAX_FILE_CHARS) {
    const sizeMB = (fileContent.length / 1_000_000).toFixed(1);
    return (
      `## Analysis Failed\n\n` +
      `File too large: \`${input.file_path}\` (${sizeMB}M chars, limit: ${MAX_FILE_CHARS / 1_000_000}M)\n\n` +
      `**Recovery:** The file exceeds the 800K character limit. ` +
      `Try analyzing a specific section, or split the file and analyze parts individually.`
    );
  }

  const fileName = basename(input.file_path);
  const fileChars = fileContent.length;
  const fileLines = fileContent.split("\n").length;

  logger.info(
    `analyze_file: ${fileName} (${fileLines} lines, ${fileChars} chars)`
  );

  // Step 5: Pick a large-context model
  const model = await pickLargeContextModel(provider, input.model);
  if (!model) {
    return (
      `## Analysis Failed\n\n` +
      `No models available for file analysis.\n\n` +
      `**Recovery:** The user needs to start a model provider. ` +
      `Tell them to start CLIProxyAPI or Ollama, then retry. ` +
      `You can verify provider status by calling list_models first.`
    );
  }

  logger.info(`analyze_file: using model ${model}`);

  // Step 6: Build prompt with file content
  const analysisPrompt = `You are analyzing a file. Answer the user's question about this file.
Be specific — include line numbers, function names, variable names, and exact code when relevant.

File: ${input.file_path}
Lines: ${fileLines}
Characters: ${fileChars}

\`\`\`
${fileContent}
\`\`\`

Question: ${input.prompt}`;

  // Step 7: Query the model
  let response: QueryResponse;
  try {
    response = await provider.query(model, analysisPrompt, {
      temperature: 0.2,
      max_tokens: input.max_tokens,
    });
  } catch (err) {
    return (
      `## Analysis Failed\n\n` +
      `Model query failed: ${err instanceof Error ? err.message : String(err)}\n\n` +
      `**Recovery:** Try a different model or check provider status with list_models.`
    );
  }

  // Step 8: Compress if requested
  let compression: CompressionResult | undefined;
  if (input.max_response_tokens) {
    compression = await compressResponse(
      provider,
      response,
      input.max_response_tokens
    );
  }

  const totalMs = Date.now() - startTime;

  // Step 9: Format response
  return formatResponse(
    response,
    input.format ?? "detailed",
    compression,
    {
      fileName,
      filePath: input.file_path,
      fileLines,
      fileChars,
      totalMs,
    },
    input.include_raw ?? false
  );
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

interface FileMetadata {
  fileName: string;
  filePath: string;
  fileLines: number;
  fileChars: number;
  totalMs: number;
}

function formatResponse(
  response: QueryResponse,
  format: "brief" | "detailed",
  compression: CompressionResult | undefined,
  meta: FileMetadata,
  includeRaw: boolean
): string {
  const content = compression?.content ?? response.content;

  // Calculate context savings: tokens Claude would have burned reading the file
  const fileTokensEstimate = Math.ceil(meta.fileChars / 4);
  const responseTokens =
    compression?.compressedTokens ??
    response.usage?.completion_tokens ??
    Math.ceil(content.length / 4);
  const contextSaved = fileTokensEstimate - responseTokens;

  if (format === "brief") {
    const lines = [
      `**${meta.fileName}** → ${response.model} (${meta.totalMs}ms)`,
      "",
      content,
      "",
      `*Context saved: ~${contextSaved.toLocaleString()} tokens*`,
    ];
    if (compression?.compressed) {
      const saved = (compression.originalTokens ?? 0) - (compression.compressedTokens ?? 0);
      lines.push(
        `*Distilled by ${compression.compressorModel} — saved additional ${saved} tokens*`
      );
    }
    return lines.join("\n");
  }

  // Detailed format
  const lines = [
    `## File Analysis: ${meta.fileName}`,
    "",
    content,
    "",
    "---",
    `**File:** \`${meta.filePath}\` (${meta.fileLines} lines, ${meta.fileChars} chars)`,
    `**Model:** ${response.model} | **Latency:** ${response.latency_ms}ms | **Total:** ${meta.totalMs}ms`,
    `**Context saved:** ~${contextSaved.toLocaleString()} tokens (Claude didn't read ${meta.fileChars.toLocaleString()} chars)`,
  ];

  if (response.usage) {
    lines.push(
      `**Tokens:** ${response.usage.prompt_tokens} in → ${response.usage.completion_tokens} out (${response.usage.total_tokens} total)`
    );
  }

  if (compression?.compressed) {
    const orig = compression.originalTokens ?? 0;
    const comp = compression.compressedTokens ?? 0;
    const saved = orig - comp;
    const pct = orig > 0 ? Math.round((saved / orig) * 100) : 0;

    lines.push(
      `**Distilled:** ${orig} → ${comp} tokens by ${compression.compressorModel} (${compression.compressorLatency}ms)`
    );
    lines.push(`**Saved:** ${saved} tokens (${pct}% smaller)`);
  }

  // Escape hatch: include raw uncompressed response
  if (includeRaw && compression?.compressed && compression.rawContent) {
    lines.push("");
    lines.push(
      `<details>\n<summary>Raw response (${compression.originalTokens ?? "?"} tokens, before distillation)</summary>\n\n${compression.rawContent}\n\n</details>`
    );
  }

  return lines.join("\n");
}
