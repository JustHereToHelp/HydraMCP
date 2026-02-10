/**
 * CLIProxyAPI Backend — talks to a running CLIProxyAPI instance.
 *
 * CLIProxyAPI exposes an OpenAI-compatible API at localhost:8317.
 * We send standard /v1/chat/completions requests and parse the responses.
 * This is our "day 1" backend — get things working, iterate on UX,
 * then decide if we need something else.
 */

import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";
import { isReasoningModel, adjustMaxTokens } from "../utils/reasoning-models.js";
import { fetchWithTimeout } from "../utils/fetch-with-timeout.js";
import { withRetry } from "../utils/retry.js";
import { validateResponse } from "../utils/response-validator.js";
import { logQuery, generateRequestId } from "../utils/logger.js";

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
      const res = await fetchWithTimeout(`${this.baseUrl}/v1/models`, {
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetchWithTimeout(`${this.baseUrl}/v1/models`, {
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
    const requestId = generateRequestId();

    const reasoning = isReasoningModel(model);
    const effectiveMaxTokens = options?.max_tokens !== undefined
      ? adjustMaxTokens(model, options.max_tokens)
      : undefined;
    const requestTimeout = reasoning
      ? parseInt(process.env.HYDRA_REASONING_TIMEOUT_MS ?? "180000", 10)
      : undefined;

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
    if (effectiveMaxTokens !== undefined) {
      body.max_tokens = effectiveMaxTokens;
      // Some providers use max_completion_tokens for reasoning models
      if (reasoning) body.max_completion_tokens = effectiveMaxTokens;
    }

    try {
      const result = await withRetry(async () => {
        const res = await fetchWithTimeout(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
        }, requestTimeout);

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Model query failed (${res.status}): ${errorText}`);
        }

        const data = (await res.json()) as {
          choices?: Array<{
            message?: { content?: string; reasoning_content?: string };
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

        // For reasoning models: if content is empty but reasoning_content exists,
        // the model burned all tokens on thinking. Surface the reasoning as fallback.
        let content = choice?.message?.content ?? "";
        const reasoningContent = choice?.message?.reasoning_content;

        if (!content && reasoningContent && reasoning) {
          content = `*[Model produced reasoning but no final answer — showing reasoning output]*\n\n${reasoningContent}`;
        }

        const response: QueryResponse = {
          model,
          content,
          reasoning_content: reasoningContent,
          usage: data.usage,
          latency_ms,
          finish_reason: choice?.finish_reason,
        };

        return validateResponse(response);
      });

      logQuery({ requestId, model, latency_ms: result.latency_ms, status: "ok", finish_reason: result.finish_reason });
      return result;
    } catch (err) {
      logQuery({ requestId, model, latency_ms: Date.now() - startTime, status: "error" });
      throw err;
    }
  }
}
