/**
 * Anthropic Native Provider — direct API calls to api.anthropic.com.
 *
 * Set ANTHROPIC_API_KEY and you're done.
 * Uses the Messages API (not OpenAI-compatible).
 *
 * API docs: https://docs.anthropic.com/en/api/messages
 */

import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";

/** Well-known Claude models. Updated as new models ship. */
const KNOWN_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", provider: "anthropic" },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", provider: "anthropic" },
];

export class AnthropicProvider implements Provider {
  name = "Anthropic";
  private apiKey: string;
  private baseUrl: string;
  private apiVersion: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
    this.apiVersion = "2023-06-01";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.apiVersion,
    };
  }

  async healthCheck(): Promise<boolean> {
    // Anthropic has no lightweight health endpoint.
    // Verify the key works by attempting a minimal request.
    // We use a cheap short prompt to avoid wasting tokens.
    try {
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      // 200 = works, 401 = bad key, anything else = maybe works
      return res.status !== 401;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Anthropic doesn't have a reliable model listing endpoint.
    // Return well-known models. The circuit breaker will disable
    // any that fail at query time.
    return KNOWN_MODELS;
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model,
      max_tokens: options?.max_tokens ?? 4096,
      messages: [{ role: "user", content: prompt }],
    };

    if (options?.system_prompt) body.system = options.system_prompt;
    if (options?.temperature !== undefined) body.temperature = options.temperature;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Anthropic query failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      model?: string;
      stop_reason?: string;
      usage?: {
        input_tokens: number;
        output_tokens: number;
      };
    };

    const latency_ms = Date.now() - startTime;
    const text = data.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("") ?? "";

    return {
      model,
      content: text,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.input_tokens,
            completion_tokens: data.usage.output_tokens,
            total_tokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
      latency_ms,
      finish_reason: data.stop_reason ?? "stop",
    };
  }
}
