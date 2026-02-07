/**
 * smart_read — Surgical code extraction from files.
 *
 * The evolution of analyze_file. Instead of analyzing a whole file,
 * smart_read extracts ONLY the relevant code sections with line numbers.
 * A 5000-line file becomes 50 lines of output — 99% token savings.
 *
 * Key difference from analyze_file:
 * - analyze_file returns ANALYSIS (prose about the file)
 * - smart_read returns EXTRACTION (actual code sections with line numbers)
 *
 * The worker model acts as a "surgical code reader" that:
 * 1. Reads the entire file server-side (Claude never sees raw content)
 * 2. Identifies relevant code sections based on the query
 * 3. Returns verbatim code with line numbers and minimal annotation
 */

import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
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

export const smartReadSchema = z.object({
  file_path: z
    .string()
    .describe(
      "Absolute path to the file to read. The file is read server-side — it never enters your context window."
    ),
  query: z
    .string()
    .describe(
      "What to find or extract from the file. Be specific: 'error handling logic', " +
      "'the authentication middleware', 'database connection setup', 'how routes are registered'."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model to use for extraction. Auto-picks a large-context model (Gemini 1M) if omitted."
    ),
  max_response_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum tokens in the response returned to you. If the extraction exceeds this, " +
      "it will be distilled by a fast model to fit — preserving code sections while " +
      "compressing annotations. Omit for no compression."
    ),
  max_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .default(2048)
    .describe(
      "Maximum tokens the extraction model generates (default: 2048, higher than " +
      "analyze_file to accommodate complete code sections)"
    ),
  format: z
    .enum(["brief", "detailed"])
    .optional()
    .default("detailed")
    .describe(
      "Response format — 'brief' for token-efficient output, 'detailed' for full metadata"
    ),
  include_raw: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true and compression is active, include the original uncompressed extraction " +
      "for quality comparison. Use this to verify distillation preserved code sections."
    ),
});

export type SmartReadInput = z.infer<typeof smartReadSchema>;

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

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

function buildExtractionPrompt(
  filePath: string,
  fileContent: string,
  fileLines: number,
  query: string
): string {
  return `You are a surgical code reader. Given a file and a search query, extract ONLY the relevant sections.

File: ${filePath} (${fileLines} lines)

\`\`\`
${fileContent}
\`\`\`

Query: ${query}

RULES:
- Extract verbatim code sections relevant to the query
- For each section include: line range (e.g. "Lines 45-67"), the actual code with original indentation, and a one-line explanation of relevance
- Include 2-3 lines of surrounding context for each section
- Preserve code exactly as written — do not modify, summarize, or paraphrase code
- If no relevant sections found, state clearly: "No relevant sections found for: ${query}"
- Order sections by relevance (most relevant first)
- Keep annotations minimal — this is extraction, not analysis
- Output as markdown with fenced code blocks and line annotations

OUTPUT FORMAT:

### Lines 45-67: Brief description of what this section does
\`\`\`
[exact code from the file]
\`\`\`

### Lines 112-125: Brief description
\`\`\`
[exact code from the file]
\`\`\``;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function smartRead(
  provider: Provider,
  input: SmartReadInput
): Promise<string> {
  const startTime = Date.now();

  // Step 1: Validate file exists
  if (!existsSync(input.file_path)) {
    return (
      `## Smart Read Failed\n\n` +
      `File not found: \`${input.file_path}\`\n\n` +
      `**Recovery:** Check the file path. Use an absolute path.`
    );
  }

  // Step 2: Check for binary files
  if (isBinaryFile(input.file_path)) {
    return (
      `## Smart Read Failed\n\n` +
      `Binary file detected: \`${input.file_path}\`\n\n` +
      `**Recovery:** Only text files are supported. Do not retry with this file.`
    );
  }

  // Step 3: Read the file server-side
  let fileContent: string;
  try {
    fileContent = readFileSync(input.file_path, "utf-8");
  } catch (err) {
    return (
      `## Smart Read Failed\n\n` +
      `Could not read file: \`${input.file_path}\`\n` +
      `Error: ${err instanceof Error ? err.message : String(err)}\n\n` +
      `**Recovery:** Check file permissions and ensure the path is correct.`
    );
  }

  // Step 4: Check file size
  if (fileContent.length > MAX_FILE_CHARS) {
    const sizeMB = (fileContent.length / 1_000_000).toFixed(1);
    return (
      `## Smart Read Failed\n\n` +
      `File too large: \`${input.file_path}\` (${sizeMB}M chars, limit: ${MAX_FILE_CHARS / 1_000_000}M)\n\n` +
      `**Recovery:** The file exceeds the 800K character limit. ` +
      `Try a specific section or ask the user to split the file.`
    );
  }

  const fileName = basename(input.file_path);
  const fileChars = fileContent.length;
  const fileLines = fileContent.split("\n").length;

  logger.info(
    `smart_read: ${fileName} (${fileLines} lines, ${fileChars} chars) — query: "${input.query}"`
  );

  // Step 5: Pick a large-context model
  const model = await pickLargeContextModel(provider, input.model);
  if (!model) {
    return (
      `## Smart Read Failed\n\n` +
      `No models available for file extraction.\n\n` +
      `**Recovery:** Start CLIProxyAPI or Ollama, then retry. ` +
      `Call list_models to verify provider status.`
    );
  }

  logger.info(`smart_read: using model ${model}`);

  // Step 6: Build extraction prompt
  const extractionPrompt = buildExtractionPrompt(
    input.file_path,
    fileContent,
    fileLines,
    input.query
  );

  // Step 7: Query the model
  let response: QueryResponse;
  try {
    response = await provider.query(model, extractionPrompt, {
      temperature: 0.1,
      max_tokens: input.max_tokens,
    });
  } catch (err) {
    return (
      `## Smart Read Failed\n\n` +
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
      query: input.query,
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
  query: string;
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
    `## Smart Read: ${meta.fileName}`,
    "",
    content,
    "",
    "---",
    `**File:** \`${meta.filePath}\` (${meta.fileLines} lines, ${meta.fileChars} chars)`,
    `**Query:** "${meta.query}"`,
    `**Model:** ${response.model} | **Latency:** ${response.latency_ms}ms | **Total:** ${meta.totalMs}ms`,
    `**Context saved:** ~${contextSaved.toLocaleString()} tokens (Claude got ${responseTokens.toLocaleString()} tokens instead of reading ${meta.fileChars.toLocaleString()} chars)`,
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

  // Escape hatch: include raw uncompressed extraction
  if (includeRaw && compression?.compressed && compression.rawContent) {
    lines.push("");
    lines.push(
      `<details>\n<summary>Raw extraction (${compression.originalTokens ?? "?"} tokens, before distillation)</summary>\n\n${compression.rawContent}\n\n</details>`
    );
  }

  return lines.join("\n");
}
