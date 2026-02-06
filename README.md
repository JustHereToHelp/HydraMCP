# HydraMCP

Connect agents to agents.

an MCP server that lets Claude Code query any LLM through your existing subscriptions. no extra API keys, no per-token billing. just your monthly subscriptions working together from one terminal.

## what it looks like

four models, four ecosystems, one prompt. this is real output from a live session:

```
> compare gpt-5-codex, gemini-3, claude-sonnet, and local qwen on this function review

## Model Comparison (4 models, 11637ms total)

| Model                      | Latency         | Tokens |
|----------------------------|-----------------|--------|
| gpt-5-codex                | 1630ms fastest  | 194    |
| gemini-3-pro-preview       | 11636ms         | 1235   |
| claude-sonnet-4-5-20250929 | 3010ms          | 202    |
| ollama/qwen2.5-coder:14b   | 8407ms          | 187    |
```

all four independently found the same async bug. then each one caught something different the others missed. GPT-5 was fastest, Gemini was most thorough, Claude gave the fix direction, Qwen explained the why. different training, different strengths, one comparison.

and this is consensus with a local judge:

```
> get consensus from gpt-5, gemini-3, and claude-sonnet. use local qwen as judge.

## Consensus: REACHED

Strategy: majority (needed 2/3)
Agreement: 3/3 models (100%)
Judge: ollama/qwen2.5-coder:14b (686ms)
```

three cloud models polled, local model judging them. 686ms to evaluate agreement. free, no quota used.

## five tools

- **list_models** - see whats available across all your providers
- **ask_model** - query any model and get a response back
- **compare_models** - same prompt to 2-5 models in parallel, side by side with brief/detailed format
- **consensus** - poll 3-7 models, a judge model evaluates agreement, returns one answer with confidence score
- **synthesize** - fan out to multiple models, then combine their best ideas into one answer thats better than any individual response

from inside Claude Code you just say things like:
- "ask gpt-5 to review this function"
- "compare gemini and claude on this approach"
- "get consensus from 3 models on whether this is thread safe"
- "synthesize responses from gpt-5, gemini, claude, and qwen on how to design this API"

it just works. no browser tabs, no copy pasting between apps.

## how it works

```
you in Claude Code
    |
    HydraMCP (MCP Server)
    |
    Provider Interface
    |-- CLIProxyAPI  -> cloud models (OpenAI, Google, Anthropic, etc.)
    |-- Ollama       -> local models (your hardware)
    |-- [anything]   -> direct API, LM Studio, whatever speaks HTTP
```

HydraMCP sits between Claude Code and your model providers. it routes requests to the right backend, runs comparisons in parallel, and formats results to keep your context window small.

the consensus tool uses an LLM-as-judge approach. instead of naive keyword matching, it picks a model not in the poll and has it evaluate whether the responses actually agree. it understands that "start with a monolith" and "monolith because its simpler" are the same answer.

the synthesize tool goes further. it collects responses from multiple models, then a synthesizer model reads all of them and builds one combined answer. best structure from one, best insights from another, best examples from a third. the result is better than any single model could produce alone.

## setup

### prerequisites

- Node.js 18+
- Claude Code
- at least one of:
  - [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (for subscription-based cloud models)
  - [Ollama](https://ollama.com) (for local models)

### install

```bash
git clone https://github.com/Pickle-Pixel/HydraMCP.git
cd HydraMCP
npm install
npm run build
```

### configure

copy the example env and fill in your details:

```bash
cp .env.example .env
```

```env
# CLIProxyAPI backend
CLIPROXYAPI_URL=http://localhost:8317
CLIPROXYAPI_KEY=your-key-here

# Ollama backend
OLLAMA_URL=http://localhost:11434
```

### register with Claude Code

```bash
claude mcp add hydramcp -s user -- node /path/to/HydraMCP/dist/index.js
```

restart Claude Code. HydraMCP will show up in your MCP tools.

### model routing

you can target specific backends with prefixes:

- `cliproxy/gpt-5` - explicitly use CLIProxyAPI
- `ollama/qwen2.5-coder:14b` - explicitly use Ollama
- `gpt-5` - auto-detect (tries each provider until one handles it)

## credits

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) powers the subscription-based cloud backend
- [Ollama](https://ollama.com) powers the local model backend
- built with the [MCP SDK](https://github.com/modelcontextprotocol/sdk) and [Zod](https://github.com/colinhacks/zod)

I built the MCP tool layer, routing logic, and multi-model orchestration on top of these. credit where its due.

## contributing

want to add a provider? the interface is simple. check `src/providers/provider.ts` for the contract and `src/providers/ollama.ts` for a working example. implement `healthCheck()`, `listModels()`, and `query()`, register it in `src/index.ts`, and you're done.

providers we'd love to see:
- LM Studio
- OpenRouter
- direct API keys (OpenAI, Anthropic, Google)
- anything else that speaks HTTP

## license

MIT
