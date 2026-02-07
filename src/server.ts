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
    "Query any AI model with a prompt. Returns the model's response with metadata.",
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

  logger.info(`HydraMCP server created with provider: ${provider.name}`);
  return server;
}
