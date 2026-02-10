/**
 * Provider interface — the abstraction layer between our MCP tools
 * and whatever backend actually talks to the LLMs.
 *
 * Why an interface? Because today we use CLIProxyAPI, but tomorrow
 * we might want direct API calls, or our own CLI wrapper, or something
 * else entirely. The tools layer never needs to know.
 */

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface QueryOptions {
  system_prompt?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface QueryResponse {
  model: string;
  content: string;
  /** Chain-of-thought from reasoning/thinking models (if available) */
  reasoning_content?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  latency_ms: number;
  finish_reason?: string;
  warning?: string;
  /** Set when a fallback model served this response instead of the requested one */
  fallback_from?: string;
}

export interface Provider {
  /** Human-readable name for this backend */
  name: string;

  /** Check if the backend is reachable */
  healthCheck(): Promise<boolean>;

  /** List all available models */
  listModels(): Promise<ModelInfo[]>;

  /** Send a prompt to a specific model and get a response */
  query(model: string, prompt: string, options?: QueryOptions): Promise<QueryResponse>;
}
