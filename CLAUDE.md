# HydraMCP

Multi-model MCP server — lets Claude Code query any LLM through existing subscriptions (ChatGPT Plus, Gemini, Ollama local).

## Stack
- TypeScript, MCP SDK, Zod
- Build: `tsc` → dist/index.js
- Node >= 18

## Architecture
- CLIProxyAPI backend at localhost:8317 (cloud models — GPT-5, Gemini, Claude via subscriptions)
- Ollama backend at localhost:11434 (local models — qwen, llama, etc.)
- 5 tools: list_models, ask_model, compare_models, consensus, synthesize

## Config
- `.env` has backend URLs and API key (DO NOT commit or share)
- CLIProxyAPI config at `/opt/homebrew/etc/cliproxyapi.conf`

## Known Limitations
- CLIProxyAPI does NOT support Grok natively — needs xAI API key for openai-compatibility route
- ChatGPT Plus auth via CLIProxyAPI browser session — may need re-auth periodically

## Dev Commands
- `npm run build` — compile TypeScript
- `npm run dev` — watch mode
- `npm start` — run the server
