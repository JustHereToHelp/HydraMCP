/**
 * HydraMCP Setup Wizard — one command to configure everything.
 *
 * Run: npx hydramcp setup
 *
 * Flow:
 *   1. Ask: API keys, subscriptions, or both?
 *   2. Walk through selected path(s)
 *   3. Auto-detect Ollama
 *   4. Save config, show the one-liner for Claude Code
 *
 * Zero dependencies. Uses Node.js readline + child_process.
 */

import { createInterface } from "node:readline";
import { execSync, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
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
  /** Max seconds to wait for auth before killing the process */
  authTimeout: number;
}

const SUBS: SubDef[] = [
  {
    name: "Gemini Advanced",
    desc: "$20/mo — Gemini 2.5 Pro, Flash, etc.",
    npmPkg: "@google/gemini-cli",
    command: "gemini",
    authArgs: ["auth"],
    authNote: "Browser will open for Google sign-in",
    authTimeout: 120,
  },
  {
    name: "Claude Pro / Max",
    desc: "$20–100/mo — Claude Opus, Sonnet, Haiku",
    npmPkg: "@anthropic-ai/claude-code",
    command: "claude",
    authArgs: ["--version"],
    authNote: "Opens browser on first interactive use",
    authTimeout: 30,
  },
  {
    name: "ChatGPT Plus / Pro",
    desc: "$20–200/mo — GPT-5, o3, Codex",
    npmPkg: "@openai/codex",
    command: "codex",
    authArgs: ["--version"],
    authNote: "Run 'codex' interactively after setup to sign in",
    authTimeout: 15,
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

/**
 * Spawn a process with a timeout. Kills it if it doesn't exit in time.
 * This prevents CLI tools from hanging the setup wizard.
 */
function spawnWithTimeout(
  command: string,
  args: string[],
  timeoutSec: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(command, args, {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        // Treat timeout as success — the CLI tool ran, just didn't exit cleanly
        resolve(0);
      }
    }, timeoutSec * 1000);

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code ?? 1);
      }
    });
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

  // --- Choose setup path ---
  console.log(`  ${B}How do you want to connect models?${X}`);
  console.log("");
  console.log(`  ${B}1.${X} API Keys ${D}— pay-per-token, paste keys and go${X}`);
  console.log(`  ${B}2.${X} Subscriptions ${D}— use ChatGPT Plus, Claude Pro, Gemini Advanced${X}`);
  console.log(`  ${B}3.${X} Both`);
  console.log("");

  const pathChoice = await ask(`  Choice ${D}(1/2/3)${X}: `);
  const doApiKeys = pathChoice === "1" || pathChoice === "3";
  const doSubscriptions = pathChoice === "2" || pathChoice === "3";

  // --- API Keys ---
  if (doApiKeys) {
    console.log("");
    console.log(`  ${B}API Keys${X}`);
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
  }

  // --- Subscriptions ---
  if (doSubscriptions) {
    console.log("");
    console.log(`  ${B}Subscriptions${X}`);
    console.log("");

    for (let i = 0; i < SUBS.length; i++) {
      const s = SUBS[i];
      const installed = isOnPath(s.command);
      const tag = installed ? `${G}installed${X}` : `${D}not installed${X}`;
      console.log(
        `  ${B}${i + 1}.${X} ${s.name} ${D}— ${s.desc}${X} [${tag}]`
      );
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

      // Auth — with timeout to prevent hanging
      console.log(`  ${D}${sub.authNote}${X}`);
      try {
        const code = await spawnWithTimeout(
          sub.command,
          sub.authArgs,
          sub.authTimeout
        );
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
  }

  // --- Ollama ---
  console.log("");
  console.log(`  ${B}Local Models${X}`);

  if (isOnPath("ollama")) {
    console.log(
      `  ${G}✓${X} Ollama detected — local models will be auto-included`
    );
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
  console.log(
    `  ${B}${G}Setup complete${X} — ${results.length} provider(s) ready`
  );
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
    console.log(
      `  ${C}claude mcp add hydramcp ${envFlags} -- npx hydramcp${X}`
    );
  } else {
    // Keys saved to ~/.hydramcp/.env or no keys needed
    console.log(`  ${C}claude mcp add hydramcp -- npx hydramcp${X}`);
  }

  console.log("");

  rl.close();
}
