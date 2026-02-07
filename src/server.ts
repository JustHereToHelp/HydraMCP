/**
 * HydraMCP Server — the core that registers tools and handles requests.
 *
 * Architecture:
 * 1. MCP SDK handles the JSON-RPC protocol over stdio
 * 2. We register 5 tools: list_models, ask_model, compare_models, consensus, synthesize
 * 3. Each tool validates input with Zod, calls the provider, formats output
 * 4. The provider is injected — today it's CLIProxyAPI, tomorrow it could be anything
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Provider } from "./providers/provider.js";
import { askModelSchema, askModel } from "./tools/ask-model.js";
import { compareModelsSchema, compareModels } from "./tools/compare-models.js";
import { consensusSchema, consensus } from "./tools/consensus.js";
import { synthesizeSchema, synthesize } from "./tools/synthesize.js";
import { sessionRecapSchema, sessionRecap } from "./tools/session-recap.js";
import { analyzeFileSchema, analyzeFile } from "./tools/analyze-file.js";
import { logger } from "./utils/logger.js";

export function createServer(provider: Provider): McpServer {
  const server = new McpServer({
    name: "HydraMCP",
    version: "0.1.0",
  });

  // --- list_models ---
  server.tool(
    "list_models",
    "List all available models across all providers. Run this first to see what you can query.",
    {},
    async () => {
      logger.info("list_models: fetching from all providers");
      try {
        const models = await provider.listModels();
        if (models.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No models available. Make sure CLIProxyAPI or Ollama is running.",
              },
            ],
          };
        }

        // Group by provider
        const grouped = new Map<string, string[]>();
        for (const m of models) {
          const list = grouped.get(m.provider) ?? [];
          list.push(m.id);
          grouped.set(m.provider, list);
        }

        const lines: string[] = [`## Available Models (${models.length} total)`, ""];
        for (const [prov, ids] of grouped) {
          lines.push(`### ${prov}`);
          for (const id of ids) {
            lines.push(`- \`${id}\``);
          }
          lines.push("");
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`list_models failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // --- ask_model ---
  server.tool(
    "ask_model",
    `Query any AI model with a prompt. Returns the model's response with metadata.

OUTPUT: Markdown with the model's response, latency, and token usage. If max_response_tokens is set and compression occurred, includes distillation metadata (original tokens, compressed tokens, compressor model, compressor latency).

WHEN TO USE: When you need another model's perspective, analysis, or capabilities. Set max_response_tokens to control how much of your context window this response consumes — the response will be distilled by a fast model to fit the budget while preserving code, file paths, errors, and actionable details.

FAILURE MODES:
- "Model query failed (4xx/5xx)" → The model or provider is unavailable. Try a different model or check that CLIProxyAPI/Ollama is running.
- Compression silently skipped → If the compressor model is unavailable or the response already fits the budget, the raw response is returned unchanged. This is not an error.`,
    askModelSchema.shape,
    async (input) => {
      logger.info(`ask_model: querying ${input.model}`);
      try {
        const result = await askModel(provider, input);
        return { content: [{ type: "text" as const, text: result }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`ask_model failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // --- compare_models ---
  server.tool(
    "compare_models",
    "Query 2-5 models in parallel with the same prompt. Returns side-by-side comparison with latency and token metrics.",
    compareModelsSchema.shape,
    async (input) => {
      logger.info(`compare_models: querying ${input.models.join(", ")}`);
      try {
        const result = await compareModels(provider, input);
        return { content: [{ type: "text" as const, text: result }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`compare_models failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // --- consensus ---
  server.tool(
    "consensus",
    "Query 3-7 models and aggregate responses using voting strategy (majority/supermajority/unanimous). Returns consensus answer with confidence score.",
    consensusSchema.shape,
    async (input) => {
      logger.info(
        `consensus: polling ${input.models.length} models (${input.strategy})`
      );
      try {
        const result = await consensus(provider, input);
        return { content: [{ type: "text" as const, text: result }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`consensus failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // --- synthesize ---
  server.tool(
    "synthesize",
    "Query 2-5 models in parallel, then combine their best ideas into one answer. Returns a synthesized response that's better than any single model.",
    synthesizeSchema.shape,
    async (input) => {
      logger.info(
        `synthesize: querying ${input.models.length} models, synthesizer: ${input.synthesizer_model ?? "auto"}`
      );
      try {
        const result = await synthesize(provider, input);
        return { content: [{ type: "text" as const, text: result }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`synthesize failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // --- session_recap ---
  server.tool(
    "session_recap",
    `Read previous Claude Code sessions from disk and generate a smart-sized recap using a large-context model. Claude never sees the raw session data — only the distilled summary.

OUTPUT: Returns markdown starting with "## Session Recap" containing sections: Project State, What Was Built, Key Decisions, Errors Resolved, Unfinished/In Progress, File Map. Empty sections are omitted. Output size is auto-calculated (1K-30K tokens) based on session density.

WHEN TO USE: At the start of a new session when the user asks to restore context, recall previous work, or continue where they left off.

FAILURE MODES:
- "No recent project detected" + list of available projects → Retry with an explicit project path from the list.
- "Project directory not found" + available projects → The project path was misspelled or encoded wrong. Retry with a path from the available list.
- "No session files found" → The project directory exists but has no sessions. Try a different project.
- "No models available" → CLIProxyAPI or Ollama is not running. Tell the user to start their model provider.
- "Session Recap Failed" with error details → Both summarization passes failed. Retry with fewer sessions (sessions=1) or a different model.
- "Triage Only" heading → Partial success. The triage pass worked but the full recap failed. The output still contains useful structured data. Do not retry.`,
    sessionRecapSchema.shape,
    async (input) => {
      logger.info(`session_recap: recapping ${input.sessions} sessions`);
      try {
        const result = await sessionRecap(provider, input);
        return { content: [{ type: "text" as const, text: result }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`session_recap failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // --- analyze_file ---
  server.tool(
    "analyze_file",
    `Offload file analysis to a worker model. The file is read server-side — it never enters your context window. You send a file path and a question, and get back only the analysis.

OUTPUT: Markdown with the model's analysis of the file, including file metadata (path, lines, chars), latency, and token usage. If max_response_tokens is set and compression occurred, includes distillation metadata (original tokens, compressed tokens, compressor model, compressor latency).

WHEN TO USE: When you need to analyze, review, or search a file but want to avoid reading it yourself. Especially valuable for large files (1000+ lines) where reading would consume significant context. The file is sent to a large-context model (Gemini 1M) that can process the entire file at once.

FAILURE MODES:
- "File not found" → The path is wrong. Retry with the correct absolute path.
- "Binary file detected" → Only text files are supported. Do not retry with this file.
- "File too large" → The file exceeds 800K chars. Try analyzing a specific section or ask the user to split the file.
- "No models available" → CLIProxyAPI or Ollama is not running. Tell the user to start their model provider.
- "Model query failed" → Try a different model or check provider status with list_models.`,
    analyzeFileSchema.shape,
    async (input) => {
      logger.info(`analyze_file: ${input.file_path}`);
      try {
        const result = await analyzeFile(provider, input);
        return { content: [{ type: "text" as const, text: result }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`analyze_file failed: ${message}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  logger.info(`HydraMCP server created with provider: ${provider.name}`);
  return server;
}
