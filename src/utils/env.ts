/**
 * Minimal .env loader — no dependencies.
 *
 * Reads a .env file and sets process.env values.
 * Only sets values that aren't already defined (env vars
 * passed at runtime take priority over .env file).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnv(): void {
  // Walk up from dist/ to project root
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(__dirname, "..", "..", ".env");

  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return; // No .env file, that's fine
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
