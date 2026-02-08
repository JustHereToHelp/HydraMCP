/**
 * Subscription Provider — use your monthly subscriptions as an API.
 *
 * Reads OAuth tokens stored by CLI tools (Claude Code, Gemini CLI, Codex CLI)
 * and makes direct HTTP requests to provider APIs. No subprocess spawning.
 *
 * Token locations:
 *   Claude  → ~/.claude/.credentials.json
 *   Gemini  → ~/.gemini/oauth_creds.json
 *   Codex   → ~/.codex/auth.json
 *
 * Approach learned from CLIProxyAPI (github.com/router-for-me/CLIProxyAPI).
 * 100% our code. Zero external dependencies.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Token file readers
// ---------------------------------------------------------------------------

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

function readClaudeTokens(): OAuthTokens | null {
  try {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf-8");
    const data = JSON.parse(raw);
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt ?? 0,
    };
  } catch {
    return null;
  }
}

function readGeminiTokens(): OAuthTokens | null {
  try {
    const raw = readFileSync(join(homedir(), ".gemini", "oauth_creds.json"), "utf-8");
    const data = JSON.parse(raw);
    if (!data.access_token || !data.refresh_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expiry_date ?? 0,
    };
  } catch {
    return null;
  }
}

function readCodexTokens(): OAuthTokens | null {
  try {
    const raw = readFileSync(join(homedir(), ".codex", "auth.json"), "utf-8");
    const data = JSON.parse(raw);
    const tokens = data.tokens;
    if (!tokens?.access_token || !tokens?.refresh_token) return null;
    // Codex access_token is a JWT — extract exp from payload
    let expiresAt = 0;
    try {
      const payload = JSON.parse(
        Buffer.from(tokens.access_token.split(".")[1], "base64").toString()
      );
      if (payload.exp) expiresAt = payload.exp * 1000; // sec → ms
    } catch { /* non-JWT or malformed — treat as no expiry */ }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function refreshClaudeToken(refreshToken: string): Promise<OAuthTokens | null> {
  try {
    const res = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const accessToken = data.access_token as string;
    const newRefresh = data.refresh_token as string;
    const expiresIn = (data.expires_in as number) ?? 86400;
    if (!accessToken) return null;

    // Write back to credentials file
    try {
      const credPath = join(homedir(), ".claude", ".credentials.json");
      const existing = JSON.parse(readFileSync(credPath, "utf-8"));
      existing.claudeAiOauth.accessToken = accessToken;
      existing.claudeAiOauth.refreshToken = newRefresh || refreshToken;
      existing.claudeAiOauth.expiresAt = Date.now() + expiresIn * 1000;
      writeFileSync(credPath, JSON.stringify(existing), "utf-8");
    } catch { /* non-fatal — token still works for this session */ }

    return {
      accessToken,
      refreshToken: newRefresh || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}

async function refreshGeminiToken(refreshToken: string): Promise<OAuthTokens | null> {
  try {
    const body = new URLSearchParams({
      client_id: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
      client_secret: "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",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const accessToken = data.access_token as string;
    const expiresIn = (data.expires_in as number) ?? 3600;
    if (!accessToken) return null;

    // Write back
    try {
      const credPath = join(homedir(), ".gemini", "oauth_creds.json");
      const existing = JSON.parse(readFileSync(credPath, "utf-8"));
      existing.access_token = accessToken;
      existing.expiry_date = Date.now() + expiresIn * 1000;
      if (data.id_token) existing.id_token = data.id_token;
      writeFileSync(credPath, JSON.stringify(existing, null, 2), "utf-8");
    } catch { /* non-fatal */ }

    return {
      accessToken,
      refreshToken, // Google doesn't rotate refresh tokens
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}

async function refreshCodexToken(refreshToken: string): Promise<OAuthTokens | null> {
  try {
    const body = new URLSearchParams({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    });
    const res = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const accessToken = data.access_token as string;
    const newRefresh = data.refresh_token as string;
    const expiresIn = (data.expires_in as number) ?? 864000;
    if (!accessToken) return null;

    // Write back
    try {
      const credPath = join(homedir(), ".codex", "auth.json");
      const existing = JSON.parse(readFileSync(credPath, "utf-8"));
      existing.tokens.access_token = accessToken;
      existing.tokens.refresh_token = newRefresh || refreshToken;
      if (data.id_token) existing.tokens.id_token = data.id_token;
      existing.last_refresh = new Date().toISOString();
      writeFileSync(credPath, JSON.stringify(existing, null, 2), "utf-8");
    } catch { /* non-fatal */ }

    return {
      accessToken,
      refreshToken: newRefresh || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backend definitions
// ---------------------------------------------------------------------------

interface SubBackend {
  id: string;
  displayName: string;
  readTokens: () => OAuthTokens | null;
  refreshTokens: (refreshToken: string) => Promise<OAuthTokens | null>;
  query: (token: string, model: string, prompt: string, options?: QueryOptions) => Promise<QueryResponse>;
  models: Array<{ id: string; name: string }>;
}

async function queryOpenAI(
  token: string, model: string, prompt: string, options?: QueryOptions
): Promise<QueryResponse> {
  const startTime = Date.now();
  const body: Record<string, unknown> = {
    model,
    messages: [
      ...(options?.system_prompt ? [{ role: "system", content: options.system_prompt }] : []),
      { role: "user", content: prompt },
    ],
    stream: false,
  };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI subscription query failed (${res.status}): ${err}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  const usage = data.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

  return {
    model,
    content: (message?.content as string) ?? "",
    usage,
    latency_ms: Date.now() - startTime,
    finish_reason: (choice?.finish_reason as string) ?? undefined,
  };
}

async function queryGemini(
  token: string, model: string, prompt: string, options?: QueryOptions
): Promise<QueryResponse> {
  const startTime = Date.now();
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  };
  if (options?.system_prompt) {
    body.systemInstruction = { parts: [{ text: options.system_prompt }] };
  }
  const genConfig: Record<string, unknown> = {};
  if (options?.temperature !== undefined) genConfig.temperature = options.temperature;
  if (options?.max_tokens !== undefined) genConfig.maxOutputTokens = options.max_tokens;
  if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini subscription query failed (${res.status}): ${err}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
  const parts = (candidates?.[0]?.content as Record<string, unknown>)?.parts as Array<{ text?: string }> | undefined;
  const content = parts?.map((p) => p.text ?? "").join("") ?? "";
  const meta = data.usageMetadata as Record<string, number> | undefined;

  return {
    model,
    content,
    usage: meta ? {
      prompt_tokens: meta.promptTokenCount ?? 0,
      completion_tokens: meta.candidatesTokenCount ?? 0,
      total_tokens: meta.totalTokenCount ?? 0,
    } : undefined,
    latency_ms: Date.now() - startTime,
    finish_reason: (candidates?.[0]?.finishReason as string) ?? undefined,
  };
}

async function queryAnthropic(
  token: string, model: string, prompt: string, options?: QueryOptions
): Promise<QueryResponse> {
  const startTime = Date.now();
  const body: Record<string, unknown> = {
    model,
    max_tokens: options?.max_tokens ?? 4096,
    messages: [{ role: "user", content: prompt }],
  };
  if (options?.system_prompt) body.system = options.system_prompt;
  if (options?.temperature !== undefined) body.temperature = options.temperature;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic subscription query failed (${res.status}): ${err}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const contentBlocks = data.content as Array<{ type: string; text?: string }> | undefined;
  const text = contentBlocks?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") ?? "";
  const usage = data.usage as { input_tokens: number; output_tokens: number } | undefined;

  return {
    model,
    content: text,
    usage: usage ? {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    } : undefined,
    latency_ms: Date.now() - startTime,
    finish_reason: (data.stop_reason as string) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Backend configs
// ---------------------------------------------------------------------------

const CLAUDE_BACKEND: SubBackend = {
  id: "claude-sub",
  displayName: "Claude (subscription)",
  readTokens: readClaudeTokens,
  refreshTokens: refreshClaudeToken,
  query: queryAnthropic,
  models: [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  ],
};

const GEMINI_BACKEND: SubBackend = {
  id: "gemini-sub",
  displayName: "Gemini (subscription)",
  readTokens: readGeminiTokens,
  refreshTokens: refreshGeminiToken,
  query: queryGemini,
  models: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  ],
};

const CODEX_BACKEND: SubBackend = {
  id: "codex-sub",
  displayName: "Codex (subscription)",
  readTokens: readCodexTokens,
  refreshTokens: refreshCodexToken,
  query: queryOpenAI,
  models: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "o3", name: "o3" },
    { id: "o4-mini", name: "o4-mini" },
  ],
};

const ALL_BACKENDS: SubBackend[] = [CLAUDE_BACKEND, GEMINI_BACKEND, CODEX_BACKEND];

// ---------------------------------------------------------------------------
// SubscriptionProvider
// ---------------------------------------------------------------------------

export class SubscriptionProvider implements Provider {
  name = "Subscription";
  private backends: SubBackend[] = [];
  private modelToBackend = new Map<string, SubBackend>();
  private tokenCache = new Map<string, OAuthTokens>();

  /**
   * Detect which subscription tokens exist on disk.
   * Returns the number of backends with valid tokens.
   */
  async detect(): Promise<number> {
    for (const backend of ALL_BACKENDS) {
      const tokens = backend.readTokens();
      if (tokens) {
        this.backends.push(backend);
        this.tokenCache.set(backend.id, tokens);
        for (const model of backend.models) {
          this.modelToBackend.set(model.id, backend);
        }
        logger.info(`Subscription: ${backend.displayName} detected (token on disk)`);
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
      // Partial match fallback
      const match = this.backends.find((b) =>
        b.models.some((m) => model.includes(m.id) || m.id.includes(model))
      );
      if (!match) {
        throw new Error(
          `No subscription handles model "${model}". ` +
          `Available: ${[...this.modelToBackend.keys()].join(", ")}`
        );
      }
      return this.runQuery(match, model, prompt, options);
    }
    return this.runQuery(backend, model, prompt, options);
  }

  private async runQuery(
    backend: SubBackend,
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    let tokens = this.tokenCache.get(backend.id);
    if (!tokens) {
      const fresh = backend.readTokens();
      if (!fresh) throw new Error(`${backend.displayName}: no tokens found`);
      tokens = fresh;
      this.tokenCache.set(backend.id, tokens);
    }

    // Refresh if expired (with 60s buffer)
    if (tokens.expiresAt > 0 && tokens.expiresAt < Date.now() + 60_000) {
      logger.info(`Subscription: refreshing ${backend.displayName} token`);
      const refreshed = await backend.refreshTokens(tokens.refreshToken);
      if (refreshed) {
        tokens = refreshed;
        this.tokenCache.set(backend.id, tokens);
      } else {
        logger.warn(`Subscription: ${backend.displayName} token refresh failed, trying existing token`);
      }
    }

    return backend.query(tokens.accessToken, model, prompt, options);
  }
}
