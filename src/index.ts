#!/usr/bin/env node

/**
 * HydraMCP — Entry point.
 *
 * Wires up all available providers and starts the MCP server.
 * MCP servers communicate over stdio (stdin/stdout), so once we call
 * connect(), the server takes over and listens for JSON-RPC messages
 * from Claude Code.
 *
 * Provider routing:
 *   "ollama/llama3"      → local Ollama instance
 *   "cliproxy/gpt-4o"    → CLIProxyAPI (subscription-based)
 *   "gpt-4o"             → auto-detect (tries each provider)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLIProxyAPIProvider } from "./providers/cliproxyapi.js";
import { OllamaProvider } from "./providers/ollama.js";
import { MultiProvider } from "./providers/multi-provider.js";
import { SmartProvider } from "./orchestrator/index.js";
import { createServer } from "./server.js";
import { logger } from "./utils/logger.js";
import { loadEnv } from "./utils/env.js";

async function main() {
  // Load .env before anything reads process.env
  loadEnv();

  const multi = new MultiProvider();

  // Register CLIProxyAPI backend (subscription-based cloud models)
  const cliproxy = new CLIProxyAPIProvider();
  multi.register("cliproxy", cliproxy);

  // Register Ollama backend (local models)
  const ollama = new OllamaProvider();
  multi.register("ollama", ollama);

  // Health check all providers
  const healthy = await multi.healthCheck();
  if (!healthy) {
    logger.warn(
      "No providers are reachable. HydraMCP will start anyway " +
        "and retry on first request."
    );
  }

  // Wrap with SmartProvider (orchestrator: circuit breaker, caching, metrics)
  const provider = new SmartProvider(multi);

  const server = createServer(provider);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("HydraMCP is running on stdio");
}

main().catch((err) => {
  logger.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
