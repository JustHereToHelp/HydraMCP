/**
 * OpenAI Native Provider — direct API calls, no proxy needed.
 *
 * Set OPENAI_API_KEY and you're done. Hits api.openai.com directly.
 * Same OpenAI format as CLIProxyAPI but without the middleman.
 */

import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";

/** Prefixes for models that support chat completions. */
const CHAT_MODEL_PREFIXES = [
  "gpt-4", "gpt-5", "gpt-3.5",
  "o1", "o3", "o4",
  "chatgpt",
];

export class OpenAIProvider implements Provider {
  name = "OpenAI";
  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
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
      throw new Error(`OpenAI: failed to list models (${res.status})`);
    }

    const data = (await res.json()) as {
      data?: Array<{ id: string; owned_by?: string }>;
    };

    // Filter to chat-capable models only (skip embeddings, tts, dall-e, etc.)
    return (data.data ?? [])
      .filter((m) => CHAT_MODEL_PREFIXES.some((p) => m.id.startsWith(p)))
      .map((m) => ({
        id: m.id,
        name: m.id,
        provider: "openai",
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
      throw new Error(`OpenAI query failed (${res.status}): ${errorText}`);
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
