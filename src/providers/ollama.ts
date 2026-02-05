/**
 * Ollama Backend — talks to a locally running Ollama instance.
 *
 * Ollama runs models like Llama 3, Mistral, CodeGemma, Phi, etc.
 * on your own hardware. No subscriptions, no API keys, no rate limits.
 * Just you and your GPU.
 *
 * Default endpoint: http://localhost:11434
 * Ollama exposes an OpenAI-compatible API at /v1/chat/completions
 * so the implementation looks almost identical to CLIProxyAPI.
 *
 * Why this matters for the project:
 * - HydraMCP isn't just a CLIProxyAPI wrapper anymore
 * - Users can mix cloud models (via CLIProxyAPI) with local models
 * - "Compare GPT-4o vs my local Llama 3" becomes possible
 * - Zero cost for the local side
 */

import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";

export class OllamaProvider implements Provider {
  name = "Ollama";
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) {
      throw new Error(`Failed to list Ollama models: ${res.status}`);
    }

    const data = (await res.json()) as {
      models?: Array<{ name: string; details?: { family?: string } }>;
    };

    return (data.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
      provider: "ollama",
    }));
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    const startTime = Date.now();

    // Ollama supports OpenAI-compatible endpoint
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

    if (options?.temperature !== undefined) {
      body.options = { temperature: options.temperature };
    }

    // Use Ollama's native chat endpoint (more reliable than /v1 compat)
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Ollama query failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as {
      message?: { content?: string };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const latency_ms = Date.now() - startTime;
    const prompt_tokens = data.prompt_eval_count ?? 0;
    const completion_tokens = data.eval_count ?? 0;

    return {
      model,
      content: data.message?.content ?? "",
      usage: {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
      },
      latency_ms,
      finish_reason: data.done_reason ?? "stop",
    };
  }
}
