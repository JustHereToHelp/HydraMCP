/**
 * Minimal .env loader — no dependencies.
 *
 * Loads environment variables from multiple locations (in priority order):
 *   1. Actual env vars (always win — set at runtime or via MCP config)
 *   2. Project-local .env (for development)
 *   3. ~/.hydramcp/.env (persistent config saved by `npx hydramcp setup`)
 *
 * Only sets values that aren't already defined.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

function parseEnvFile(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return; // File doesn't exist — that's fine
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();

    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnv(): void {
  // 1. Project-local .env (walk up from dist/ to project root)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  parseEnvFile(resolve(__dirname, "..", "..", ".env"));

  // 2. ~/.hydramcp/.env (persistent config from setup wizard)
  parseEnvFile(join(homedir(), ".hydramcp", ".env"));
}
