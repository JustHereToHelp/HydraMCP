/**
 * HydraMCP Setup Wizard — one command to configure everything.
 *
 * Run: npx hydramcp setup
 *
 * Walks the user through:
 *   1. API keys (OpenAI, Google, Anthropic)
 *   2. Subscriptions (installs + auths CLI tools automatically)
 *   3. Local models (detects Ollama)
 *   4. Saves config, shows the one-liner to add to Claude Code
 *
 * Zero dependencies. Uses Node.js readline + child_process.
 */

import { createInterface } from "node:readline";
import { execSync, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// ANSI formatting (works on all modern terminals including Windows 10+)
// ---------------------------------------------------------------------------

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const R = "\x1b[31m";
const X = "\x1b[0m";

// ---------------------------------------------------------------------------
// Subscription definitions
// ---------------------------------------------------------------------------

interface SubDef {
  name: string;
  desc: string;
  npmPkg: string;
  command: string;
  authArgs: string[];
  authNote: string;
}

const SUBS: SubDef[] = [
  {
    name: "Gemini Advanced",
    desc: "$20/mo — Gemini 2.5 Pro, Flash, etc.",
    npmPkg: "@anthropic-ai/gemini-cli",
    command: "gemini",
    authArgs: ["auth"],
    authNote: "Browser will open for Google sign-in",
  },
  {
    name: "Claude Pro / Max",
    desc: "$20–100/mo — Claude Opus, Sonnet, Haiku",
    npmPkg: "@anthropic-ai/claude-code",
    command: "claude",
    authArgs: ["--version"],
    authNote: "Opens browser on first interactive use",
  },
  {
    name: "ChatGPT Plus / Pro",
    desc: "$20–200/mo — GPT-5, o3, Codex",
    npmPkg: "@openai/codex",
    command: "codex",
    authArgs: ["auth"],
    authNote: "Browser will open for OpenAI sign-in",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configDir(): string {
  return join(homedir(), ".hydramcp");
}

function configPath(): string {
  return join(configDir(), ".env");
}

function isOnPath(command: string): boolean {
  try {
    execSync(
      process.platform === "win32" ? `where ${command}` : `which ${command}`,
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

function spawnInteractive(
  command: string,
  args: string[]
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function loadExistingEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = readFileSync(configPath(), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
    }
  } catch {
    // No existing config
  }
  return env;
}

function mask(key: string): string {
  if (key.length <= 8) return "****";
  return key.substring(0, 4) + "..." + key.substring(key.length - 4);
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("Setup requires an interactive terminal.");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((r) => rl.question(q, (a) => r(a.trim())));

  const existing = loadExistingEnv();
  const env: Record<string, string> = { ...existing };
  const results: string[] = [];

  // --- Banner ---
  console.log("");
  console.log(`  ${B}${C}HydraMCP Setup${X}`);
  console.log(`  ${D}Multi-model intelligence for Claude Code${X}`);
  console.log("");

  // --- API Keys ---
  console.log(`  ${B}API Keys${X} ${D}(pay-per-token, direct access)${X}`);
  console.log("");

  const keyDefs = [
    { env: "OPENAI_API_KEY", label: "OpenAI" },
    { env: "GOOGLE_API_KEY", label: "Google / Gemini" },
    { env: "ANTHROPIC_API_KEY", label: "Anthropic" },
  ];

  for (const kd of keyDefs) {
    const current = env[kd.env];
    if (current) {
      const change = await ask(
        `  ${kd.label} ${D}[${mask(current)}]${X} — keep? ${D}(Enter=yes, or paste new key)${X}: `
      );
      if (change) env[kd.env] = change;
    } else {
      const val = await ask(
        `  ${kd.label} API key ${D}(Enter to skip)${X}: `
      );
      if (val) env[kd.env] = val;
    }
    if (env[kd.env]) results.push(`${G}+${X} ${kd.label} (API key)`);
  }

  // --- Subscriptions ---
  console.log("");
  console.log(
    `  ${B}Subscriptions${X} ${D}(flat monthly rate, uses CLI tools)${X}`
  );
  console.log("");

  for (let i = 0; i < SUBS.length; i++) {
    const s = SUBS[i];
    const installed = isOnPath(s.command);
    const tag = installed ? `${G}installed${X}` : `${D}not installed${X}`;
    console.log(`  ${B}${i + 1}.${X} ${s.name} ${D}— ${s.desc}${X} [${tag}]`);
  }

  console.log("");
  const subInput = await ask(
    `  Which do you have? ${D}(e.g. 1,3 or Enter to skip)${X}: `
  );

  const selectedIndexes = subInput
    .split(",")
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < SUBS.length);

  for (const idx of selectedIndexes) {
    const sub = SUBS[idx];
    console.log("");
    console.log(`  ${C}${sub.name}${X}`);

    // Check / install
    if (isOnPath(sub.command)) {
      console.log(`  ${G}✓${X} ${sub.command} already installed`);
    } else {
      console.log(`  Installing ${sub.npmPkg}...`);
      try {
        execSync(`npm i -g ${sub.npmPkg}`, { stdio: "inherit" });
        console.log(`  ${G}✓${X} Installed`);
      } catch {
        console.log(
          `  ${R}✗${X} Install failed. Try manually: ${Y}sudo npm i -g ${sub.npmPkg}${X}`
        );
        continue;
      }
    }

    // Auth
    console.log(`  ${D}${sub.authNote}${X}`);
    try {
      const code = await spawnInteractive(sub.command, sub.authArgs);
      if (code === 0) {
        console.log(`  ${G}✓${X} Ready`);
        results.push(`${G}+${X} ${sub.name} (subscription)`);
      } else {
        console.log(
          `  ${Y}!${X} Auth may need manual setup: ${Y}${sub.command} ${sub.authArgs.join(" ")}${X}`
        );
      }
    } catch {
      console.log(
        `  ${Y}!${X} Could not run auth. Try: ${Y}${sub.command} ${sub.authArgs.join(" ")}${X}`
      );
    }
  }

  // --- Ollama ---
  console.log("");
  console.log(`  ${B}Local Models${X}`);

  if (isOnPath("ollama")) {
    console.log(`  ${G}✓${X} Ollama detected — local models will be auto-included`);
    results.push(`${G}+${X} Ollama (local)`);
  } else {
    console.log(
      `  ${D}Ollama not found. Install from https://ollama.com for local models.${X}`
    );
  }

  // --- Save config ---
  const apiKeys = Object.entries(env).filter(([, v]) => v);
  if (apiKeys.length > 0) {
    console.log("");
    const save = await ask(
      `  Save API keys to ${D}~/.hydramcp/.env${X}? ${D}(Y/n)${X}: `
    );

    if (save.toLowerCase() !== "n") {
      const dir = configDir();
      mkdirSync(dir, { recursive: true });

      const lines = [
        "# HydraMCP configuration",
        "# Generated by: npx hydramcp setup",
        "",
        ...apiKeys.map(([k, v]) => `${k}=${v}`),
        "",
      ];
      writeFileSync(configPath(), lines.join("\n"), "utf-8");
      console.log(`  ${G}✓${X} Saved to ${configDir()}/.env`);
    }
  }

  // --- Summary ---
  console.log("");
  console.log(`  ${B}${G}Setup complete${X} — ${results.length} provider(s) ready`);
  console.log("");

  if (results.length > 0) {
    for (const r of results) {
      console.log(`  ${r}`);
    }
    console.log("");
  }

  // --- Claude Code integration ---
  console.log(`  ${B}Add to Claude Code:${X}`);
  console.log("");

  if (apiKeys.length > 0 && !existsSync(configPath())) {
    // Keys not saved — need env flags
    const envFlags = apiKeys.map(([k, v]) => `-e ${k}=${v}`).join(" ");
    console.log(`  ${C}claude mcp add hydramcp ${envFlags} -- npx hydramcp${X}`);
  } else {
    // Keys saved to ~/.hydramcp/.env or no keys needed
    console.log(`  ${C}claude mcp add hydramcp -- npx hydramcp${X}`);
  }

  console.log("");

  rl.close();
}
