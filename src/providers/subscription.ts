/**
 * Subscription Provider — use your monthly subscriptions as an API.
 *
 * Wraps installed CLI tools (Gemini CLI, Claude Code, Codex CLI) that
 * authenticate via OAuth to your subscription accounts. No API keys needed.
 *
 * HydraMCP spawns the CLIs in non-interactive mode, captures their output,
 * and normalizes it to the Provider interface. The CLIs handle all auth.
 *
 * 100% our code. No CLIProxyAPI dependency.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// CLI Backend definitions
// ---------------------------------------------------------------------------

interface CLIBackend {
  /** Provider key used in model prefixes (e.g., "sub-gemini") */
  id: string;
  /** Human-readable name */
  displayName: string;
  /** CLI command to spawn */
  command: string;
  /** Args to check if CLI is installed (should exit 0) */
  versionArgs: string[];
  /** Build the argument array for a query */
  buildArgs(model: string, prompt: string, options?: QueryOptions): string[];
  /** Extract response text from CLI stdout */
  parseOutput(stdout: string): string;
  /** Models available through this subscription */
  models: Array<{ id: string; name: string }>;
  /** If true, prompt is written to stdin instead of passed as an arg */
  stdinPrompt?: boolean;
  /** Query timeout in ms */
  timeout: number;
}

const GEMINI_CLI: CLIBackend = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  command: "gemini",
  versionArgs: ["--version"],
  buildArgs(model) {
    // Gemini CLI: -p - reads prompt from stdin (avoids shell quoting issues)
    // --output-format json gives structured output
    return ["--output-format", "json", "-m", model, "-p", "-"];
  },
  stdinPrompt: true,
  parseOutput(stdout) {
    // Gemini JSON output: { response: "...", stats: { ... } }
    try {
      const data = JSON.parse(stdout);
      if (data.response) return String(data.response).trim();
      if (data.text) return String(data.text).trim();
      if (data.content) return String(data.content).trim();
      return stdout.trim();
    } catch {
      return stdout.trim();
    }
  },
  models: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3-pro", name: "Gemini 3 Pro" },
  ],
  timeout: 120_000,
};

const CLAUDE_CLI: CLIBackend = {
  id: "claude-cli",
  displayName: "Claude Code",
  command: "claude",
  versionArgs: ["--version"],
  buildArgs(model, prompt) {
    return ["-p", prompt, "--output-format", "json", "--model", model];
  },
  parseOutput(stdout) {
    // Claude Code --output-format json returns a JSON object
    // with a "result" field containing the response text.
    try {
      const data = JSON.parse(stdout);
      return data.result ?? data.content ?? stdout.trim();
    } catch {
      // If JSON parsing fails, return raw text
      return stdout.trim();
    }
  },
  models: [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  ],
  timeout: 180_000,
};

const CODEX_CLI: CLIBackend = {
  id: "codex-cli",
  displayName: "Codex CLI",
  command: "codex",
  versionArgs: ["--version"],
  buildArgs(_model, prompt) {
    // Codex exec: prompt must be a single argument.
    // Pass "-" to read from stdin instead — avoids shell quoting issues.
    return ["exec", "-"];
  },
  /** Codex reads prompt from stdin when "-" is passed */
  stdinPrompt: true,
  parseOutput(stdout) {
    // Codex exec outputs header lines (model info, session id, etc.),
    // then "user\n<prompt>\n", then "codex\n<response>\n", then "tokens used\n..."
    // Extract the codex response block.
    const lines = stdout.split("\n");
    const codexIdx = lines.findIndex((l) => l.trim() === "codex");
    if (codexIdx !== -1) {
      // Everything between "codex" and "tokens used" is the response
      const tokensIdx = lines.findIndex(
        (l, i) => i > codexIdx && l.trim().startsWith("tokens used")
      );
      const end = tokensIdx !== -1 ? tokensIdx : lines.length;
      return lines
        .slice(codexIdx + 1, end)
        .join("\n")
        .trim();
    }
    return stdout.trim();
  },
  models: [
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  ],
  timeout: 180_000,
};

/** All supported CLI backends, tried in order. */
const ALL_BACKENDS: CLIBackend[] = [GEMINI_CLI, CLAUDE_CLI, CODEX_CLI];

// ---------------------------------------------------------------------------
// CLI execution helper
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function execCLI(
  command: string,
  args: string[],
  timeout: number,
  stdinData?: string
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        // On Windows, .cmd shims from npm need a shell to resolve.
        // Arguments are passed as an array so Node quotes them safely.
        shell: process.platform === "win32",
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeout}ms`));
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    // Write prompt to stdin if needed, then close
    if (stdinData) {
      child.stdin?.write(stdinData);
    }
    child.stdin?.end();
  });
}

// ---------------------------------------------------------------------------
// SubscriptionProvider
// ---------------------------------------------------------------------------

export class SubscriptionProvider implements Provider {
  name = "Subscription";
  private backends: CLIBackend[] = [];
  /** Map model ID → backend that serves it */
  private modelToBackend: Map<string, CLIBackend> = new Map();

  /**
   * Detect which CLI tools are installed on this machine.
   * Must be called before using the provider.
   */
  async detect(): Promise<number> {
    for (const backend of ALL_BACKENDS) {
      try {
        const result = await execCLI(
          backend.command,
          backend.versionArgs,
          10_000
        );
        if (result.exitCode === 0) {
          this.backends.push(backend);
          for (const model of backend.models) {
            this.modelToBackend.set(model.id, backend);
          }
          logger.info(
            `Subscription: ${backend.displayName} detected ✓`
          );
        }
      } catch {
        // CLI not installed — skip silently
      }
    }
    return this.backends.length;
  }

  async healthCheck(): Promise<boolean> {
    return this.backends.length > 0;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.backends.flatMap((b) =>
      b.models.map((m) => ({
        id: m.id,
        name: `${m.name} (${b.displayName})`,
        provider: b.id,
      }))
    );
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    const backend = this.modelToBackend.get(model);
    if (!backend) {
      // Try to find a backend by partial match
      const match = this.backends.find((b) =>
        b.models.some((m) => model.includes(m.id) || m.id.includes(model))
      );
      if (!match) {
        throw new Error(
          `No subscription CLI handles model "${model}". ` +
            `Available: ${[...this.modelToBackend.keys()].join(", ")}`
        );
      }
      return this.runBackend(match, model, prompt, options);
    }

    return this.runBackend(backend, model, prompt, options);
  }

  private async runBackend(
    backend: CLIBackend,
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    const startTime = Date.now();
    const args = backend.buildArgs(model, prompt, options);

    logger.info(
      `Subscription: querying ${backend.displayName} (${model})`
    );

    const stdinData = backend.stdinPrompt ? prompt : undefined;
    const result = await execCLI(backend.command, args, backend.timeout, stdinData);

    if (result.exitCode !== 0) {
      throw new Error(
        `${backend.displayName} exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`
      );
    }

    const content = backend.parseOutput(result.stdout);
    const latency_ms = Date.now() - startTime;

    if (!content) {
      throw new Error(
        `${backend.displayName} returned empty response. stderr: ${result.stderr.slice(0, 500)}`
      );
    }

    return {
      model,
      content,
      latency_ms,
      finish_reason: "stop",
    };
  }
}
