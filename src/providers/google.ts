/**
 * Google Gemini Native Provider — direct API calls to Google AI.
 *
 * Set GOOGLE_API_KEY (or GEMINI_API_KEY) and you're done.
 * Uses the native Gemini API format — no OpenAI compatibility layer.
 *
 * API docs: https://ai.google.dev/api/generate-content
 */

import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";

/** Only list models that support generateContent (skip embedding, etc.) */
const GENERATIVE_MODEL_PREFIXES = [
  "gemini-",
];

export class GoogleProvider implements Provider {
  name = "Google";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string) {
    this.apiKey =
      apiKey ??
      process.env.GOOGLE_API_KEY ??
      process.env.GEMINI_API_KEY ??
      "";
    this.baseUrl = "https://generativelanguage.googleapis.com/v1beta";
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl}/models?key=${this.apiKey}&pageSize=1`
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const allModels: ModelInfo[] = [];
    let pageToken: string | undefined;

    // Paginate through all models
    do {
      const url = new URL(`${this.baseUrl}/models`);
      url.searchParams.set("key", this.apiKey);
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString());
      if (!res.ok) {
        throw new Error(`Google: failed to list models (${res.status})`);
      }

      const data = (await res.json()) as {
        models?: Array<{
          name: string;
          displayName?: string;
          supportedGenerationMethods?: string[];
        }>;
        nextPageToken?: string;
      };

      const models = (data.models ?? [])
        .filter((m) => {
          // Only include models that support generateContent
          const methods = m.supportedGenerationMethods ?? [];
          return methods.includes("generateContent");
        })
        .filter((m) => {
          // Only include Gemini models (skip legacy PaLM, embedding, etc.)
          const id = m.name.replace("models/", "");
          return GENERATIVE_MODEL_PREFIXES.some((p) => id.startsWith(p));
        })
        .map((m) => ({
          id: m.name.replace("models/", ""),
          name: m.displayName ?? m.name.replace("models/", ""),
          provider: "google",
        }));

      allModels.push(...models);
      pageToken = data.nextPageToken;
    } while (pageToken);

    return allModels;
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    const startTime = Date.now();

    // Build Gemini-native request
    const body: Record<string, unknown> = {
      contents: [
        { role: "user", parts: [{ text: prompt }] },
      ],
    };

    // System instruction (Gemini's equivalent of system prompt)
    if (options?.system_prompt) {
      body.systemInstruction = {
        parts: [{ text: options.system_prompt }],
      };
    }

    // Generation config
    const genConfig: Record<string, unknown> = {};
    if (options?.temperature !== undefined) genConfig.temperature = options.temperature;
    if (options?.max_tokens !== undefined) genConfig.maxOutputTokens = options.max_tokens;
    if (Object.keys(genConfig).length > 0) {
      body.generationConfig = genConfig;
    }

    const res = await fetch(
      `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Google query failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const latency_ms = Date.now() - startTime;
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";

    const usage = data.usageMetadata;

    return {
      model,
      content: text,
      usage: usage
        ? {
            prompt_tokens: usage.promptTokenCount ?? 0,
            completion_tokens: usage.candidatesTokenCount ?? 0,
            total_tokens: usage.totalTokenCount ?? 0,
          }
        : undefined,
      latency_ms,
      finish_reason: candidate?.finishReason?.toLowerCase() ?? "stop",
    };
  }
}
