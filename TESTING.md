# testing log

documenting what we tested, what worked, and what we want to test next. this is the raw data for when we showcase HydraMCP.

## session 1 - february 5, 2026

### setup

- CLIProxyAPI running on localhost:8317 with OpenAI/Codex subscription
- Ollama running on localhost:11434 with qwen2.5-coder:32b (32B params, Q4_K_M, 24GB VRAM)
- HydraMCP registered as global MCP server in Claude Code
- all tests run from inside a live Claude Code session

### test results

#### list_models
- pulled 10 models from CLIProxyAPI (all OpenAI/Codex family)
- pulled qwen2.5-coder:32b from Ollama
- both providers detected automatically

#### ask_model - single queries

| model | prompt | latency | tokens | notes |
|-------|--------|---------|--------|-------|
| gpt-5 | "what is MCP?" | 5,672ms | n/a | solid answer, brief format worked well |
| gpt-5-codex | "reverse a string one-liner" | 1,701ms | n/a | fast, clean code output |
| ollama/qwen2.5-coder:32b | "reverse a string one-liner" | 21,742ms | n/a | slow first request (model warmup), correct output |

#### compare_models - parallel fan-out

**test 1: opinion question across GPT versions**

prompt: "biggest mass effect in changing software development forever? 2 sentences max"

| model | latency | tokens |
|-------|---------|--------|
| gpt-5 | 6,568ms | 546 |
| gpt-5.1 | 2,443ms (fastest) | 199 |
| gpt-5.2 | 5,357ms | 171 |

interesting: gpt-5 gave the longest answer (546 tokens) even with the same prompt. gpt-5.1 was fastest and most concise. all three mentioned open source/internet as the big shift but framed it differently.

**test 2: code review - cloud vs local**

prompt: review a debounce function, point out issues in 3 bullet points

| model | latency | tokens |
|-------|---------|--------|
| gpt-5-codex (cloud) | 9,965ms (fastest) | 1,326 |
| qwen2.5-coder:32b (local) | 17,025ms | 268 |

this one was the best demo. both models independently found the same two issues:
- `this` context is lost because of arrow function wrapper
- no cancel mechanism to stop a pending timeout

then they each found a different third issue:
- gpt-5-codex: return value is always undefined, can't await it
- qwen2.5-coder: no option for immediate/leading-edge execution

both valid. different perspectives from different models. this is exactly why compare_models exists.

gpt-5-codex also rewrote the entire function as a fix. qwen kept it to explanation only. different styles, both useful.

#### consensus - multi-model voting

prompt: "Is TypeScript a superset of JavaScript? yes or no, one sentence"

| detail | value |
|--------|-------|
| models | gpt-5, gpt-5.1, gpt-5.2 |
| strategy | majority (need 2/3) |
| result | REACHED, 3/3 (100%) |
| answer | "Yes, TypeScript is a syntactic superset of JavaScript that adds optional static typing" |

consensus worked perfectly on a factual question. all three agreed. keyword matching was enough here because the answers were structurally similar.

### observations

1. **gpt-5-codex is consistently faster than gpt-5** for code tasks (1.7s vs 5.7s). makes sense, its optimized for that
2. **ollama first request is slow** (21s) due to model loading. subsequent requests should be faster
3. **compare_models is the killer feature.** seeing two models side by side on the same code review immediately shows you their strengths
4. **consensus works on factual questions** but we haven't tested it on subjective ones yet. the naive keyword matching will probably break there
5. **token usage varies wildly.** gpt-5 used 546 tokens for a 2-sentence answer, gpt-5.1 used 199 for the same prompt. model choice matters for context efficiency

### bugs found

- compare_models table had an empty trailing column (fixed in source, needs server restart to take effect)
- compare_models doesn't have a `format` option like ask_model does (feature gap)

---

## tests to run next session

### multi-provider comparisons (the showcase tests)

these are the tests that demonstrate why HydraMCP exists. run these when we have multiple providers authenticated.

#### code tasks
- [ ] "write a binary search in python" - compare cloud vs local, see who writes cleaner code
- [ ] "find the bug in this code" (intentionally buggy snippet) - see which model catches it first
- [ ] "refactor this function to be more readable" - subjective task, interesting to compare styles
- [ ] "write unit tests for this function" - practical real-world use case

#### reasoning tasks
- [ ] "is this database schema normalized?" - give it a schema, see if models agree
- [ ] "which approach is better: X or Y?" - subjective, good test for consensus breaking
- [ ] "explain this regex" - different models explain things differently

#### consensus stress tests
- [ ] factual question all models should agree on (baseline)
- [ ] subjective question where models should disagree (test if consensus correctly reports NOT REACHED)
- [ ] trick question with a wrong assumption baked in (do models catch it?)
- [ ] same question twice in a row (consistency check)

#### performance tests
- [ ] ollama cold start vs warm (first request vs second)
- [ ] 5 model compare (max allowed) - how long does it take?
- [ ] back to back queries - does anything break under repeated use?

#### format and UX tests
- [ ] compare_models with brief format (once we add it)
- [ ] very long response from one model - does it blow up the context?
- [ ] model that doesn't exist - does the error message make sense?
- [ ] one model fails mid-comparison - does graceful degradation work?

### provider milestones

when we hit each of these, run the full test suite above:

- [ ] **milestone 1:** CLIProxyAPI + Ollama (where we are now)
- [ ] **milestone 2:** add Gemini subscription through CLIProxyAPI (authenticate antigravity provider)
- [ ] **milestone 3:** add Claude subscription through CLIProxyAPI
- [ ] **milestone 4:** 3+ cloud providers + local, full cross-provider comparison
- [ ] **milestone 5:** community-contributed provider (LM Studio, OpenRouter, etc.)

### showcase readiness checklist

before going public or doing a demo, we should be able to show:

- [ ] list_models pulling from 2+ providers
- [ ] ask_model working with cloud and local
- [ ] compare_models with at least one cloud vs local comparison
- [ ] consensus reaching agreement on a factual question
- [ ] consensus NOT reaching agreement on a subjective question
- [ ] graceful error when a model or provider is down
- [ ] clean README with real output examples (not placeholder text)

---

*this doc gets updated every session. raw data, no polish.*
