# HydraMCP

connect agents to agents.

an MCP server that lets Claude Code query any LLM through your existing subscriptions. no extra API keys, no per-token billing. just your $20/month subscriptions actually working together.

## what it does

four MCP tools:

- **list_models** - see whats available across all your providers
- **ask_model** - query any model (GPT, Gemini, Llama, whatever) and get a response
- **compare_models** - same prompt to 2-5 models in parallel, side by side
- **consensus** - poll 3-7 models and get one answer with a confidence score

from inside Claude Code you can say things like:
- "ask gpt-5 to review this function"
- "compare gpt-5 and llama3 on this code"
- "get consensus from 3 models on whether this approach is correct"

and it just works. no browser tabs, no copy pasting between apps.

## how it works

```
you in Claude Code
    |
    HydraMCP (MCP Server)
    |
    Provider Interface
    |-- CLIProxyAPI  -> cloud models (your subscriptions)
    |-- Ollama       -> local models (your hardware)
    |-- [anything]   -> direct API, LM Studio, etc.
```

HydraMCP sits between Claude Code and your model providers. it routes requests to the right backend, runs comparisons in parallel, and formats results to keep your context window lean.

the provider interface means backends are swappable. if one dies, plug in another. the tool layer stays the same.

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

## usage

once registered, the tools are available in any Claude Code session:

```
> use list_models to show whats available

> ask gpt-5 what it thinks about this approach

> compare gpt-5 and gpt-5-codex on this function review

> get consensus from gpt-5, gpt-5.1, and gpt-5.2 on whether this is thread safe
```

### model routing

you can target specific backends with prefixes:

- `cliproxy/gpt-5` - explicitly use CLIProxyAPI
- `ollama/llama3` - explicitly use Ollama
- `gpt-5` - auto-detect (tries each provider)

## credits

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) powers the subscription-based cloud backend
- [Ollama](https://ollama.com) powers the local model backend
- built with the [MCP SDK](https://github.com/modelcontextprotocol/sdk) and [Zod](https://github.com/colinhacks/zod)

we built the MCP tool layer and routing logic on top of these. credit where its due.

## license

MIT
