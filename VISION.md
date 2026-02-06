# HydraMCP

## why this exists

I pay for Claude. I pay for ChatGPT. I pay for Gemini. three subscriptions, three separate apps, three separate auth flows. and none of them can talk to each other.

if I'm in Claude Code and I want GPT's take on something, I have to open a browser, paste the code, wait, read it, come back. if I want to compare three models on the same question I'm literally copy pasting between tabs like its 2015. I'm the router. I'm the middleware. that's dumb.

so I built HydraMCP. an MCP server that lets one AI agent ask other AI agents for help. from inside Claude Code you can query GPT, Gemini, Llama, whatever, through the subscriptions you already pay for. no extra API keys, no per-token billing surprises.

## what it actually does

four tools, one MCP server:

- **list_models** - see whats available across all your providers
- **ask_model** - send a prompt to any model and get a response back
- **compare_models** - same prompt, 2-5 models in parallel, side by side results with brief/detailed format control
- **consensus** - poll multiple models, a separate judge model evaluates whether they agree, returns one answer with a confidence score

the consensus tool is worth calling out. we tried naive keyword matching first and it was garbage. models would say the exact same thing in different words and it would report "no agreement." so we replaced it with an LLM-as-judge approach. one of the available models (auto-picked, or you choose) reads all responses and decides which ones actually agree. its models judging models. it works.

the magic is that it works with your existing subscriptions. you're already paying $20/month for these services. HydraMCP just lets you actually use them together.

## the idea we stand by

### agents talking to agents

this is the core. not "another API wrapper" not "another proxy." the whole point is that your AI coding agent can consult other AI models without you leaving your terminal. Claude asking GPT for a second opinion. thats agent to agent communication and nobody is really doing it through MCP right now.

### subscriptions first, API keys second

most devs don't want to deal with API key management and watching their token usage tick up. they want the flat rate thing. they already have it. we just make it usable from one place.

### we don't own the backend and thats fine

CLIProxyAPI handles the subscription session management. Ollama handles local models. we built a provider interface so any backend can plug in. if CLIProxyAPI disappears tomorrow we add a different backend and nothing else changes. the value is in our tool layer and the MCP protocol, not in the plumbing underneath.

### credit where its due

CLIProxyAPI powers the cloud side. Ollama powers the local side. we don't hide that. we don't pretend we built everything from scratch. we built the layer on top that makes these things useful together. thats honest and thats how open source should work.

## how it looks

```
you in Claude Code
    |
    "compare gpt-5 and llama3 on this function"
    |
    HydraMCP (MCP Server)
    |-- compare_models, ask_model, consensus, list_models
    |
    Provider Interface
    |-- CLIProxyAPI  -> cloud models (your subscriptions)
    |-- Ollama       -> local models (your hardware)
    |-- [whatever]   -> direct API, LM Studio, anything else
```

## where we are now

this started as a skeleton and now its a working system. we've run real comparisons between cloud models and local models on code reviews, bug finding, refactoring. the tools work. the routing works. the consensus judge catches agreement that keyword matching completely missed.

right now we have CLIProxyAPI for cloud (OpenAI/Codex family) and Ollama for local (qwen2.5-coder). but CLIProxyAPI supports 8+ providers including Gemini, Claude, Antigravity (Gemini 3, free preview), Qwen, and a generic OpenAI-compatible passthrough for anything else. most of them are one OAuth command away.

## whats next

the real demo is cross-ecosystem. GPT-5 vs Gemini 3 vs Claude Sonnet vs local Qwen on the same code review. four different training philosophies, four different perspectives, one terminal. thats not a feature comparison, thats actually useful.

what we're building toward:
- more providers authenticated (Antigravity and Claude are next, both one command away)
- the cross-provider comparison that proves the concept
- streaming responses
- README with real output examples from actual multi-provider comparisons
- whatever else makes sense once we actually use this day to day

the core belief stays the same though. agents should talk to agents. your subscriptions should work together. and you shouldnt have to leave your terminal to make it happen.

thats HydraMCP.

---

*started: february 5, 2026*
*built by: PicklePixel*
