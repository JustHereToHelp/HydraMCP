/**
 * CLIProxyAPI Backend — talks to a running CLIProxyAPI instance.
 *
 * CLIProxyAPI exposes an OpenAI-compatible API at localhost:8317.
 * We send standard /v1/chat/completions requests and parse the responses.
 * This is our "day 1" backend — get things working, iterate on UX,
 * then decide if we need something else.
 */

import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";

export class CLIProxyAPIProvider implements Provider {
  name = "CLIProxyAPI";
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl ?? process.env.CLIPROXYAPI_URL ?? "http://localhost:8317";
    this.apiKey = apiKey ?? process.env.CLIPROXYAPI_KEY ?? "";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Failed to list models: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      data?: Array<{ id: string; owned_by?: string }>;
    };

    return (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.id,
      provider: m.owned_by ?? "unknown",
    }));
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(options?.system_prompt
          ? [{ role: "system", content: options.system_prompt }]
          : []),
        { role: "user", content: prompt },
      ],
      stream: false,
    };

    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Model query failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const latency_ms = Date.now() - startTime;
    const choice = data.choices?.[0];

    return {
      model,
      content: choice?.message?.content ?? "",
      usage: data.usage,
      latency_ms,
      finish_reason: choice?.finish_reason,
    };
  }
}
