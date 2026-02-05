#!/usr/bin/env node

/**
 * HydraMCP — Entry point.
 *
 * This file does one thing: wire up the provider and start the server.
 * MCP servers communicate over stdio (stdin/stdout), so once we call
 * connect(), the server takes over and listens for JSON-RPC messages
 * from Claude Code.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLIProxyAPIProvider } from "./providers/cliproxyapi.js";
import { createServer } from "./server.js";
import { logger } from "./utils/logger.js";

async function main() {
  const provider = new CLIProxyAPIProvider();

  // Health check — warn but don't fail (CLIProxyAPI might start later)
  const healthy = await provider.healthCheck();
  if (!healthy) {
    logger.warn(
      "CLIProxyAPI is not reachable. Make sure it's running. " +
        "HydraMCP will start anyway and retry on first request."
    );
  }

  const server = createServer(provider);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("HydraMCP is running on stdio");
}

main().catch((err) => {
  logger.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
