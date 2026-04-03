# 🦞🟠 Clawflare

OpenClaw bridge and plugin suite for Cloudflare's Native AI Workers (`@cf`).

Built by [Divinci AI](https://github.com/Divinci-AI)

---

## Why This Exists

OpenClaw's `openai-responses` API always sends requests to `/responses` using the OpenAI Responses API format — flat tool definitions, `input[]` messages, no `function` wrapper. Cloudflare's `/responses` endpoint **does not support custom function tools** (only built-ins like `web_search` and `computer_use`).

Cloudflare's `/chat/completions` endpoint **does** support custom function tools, but in Chat Completions format with the wrapped `{ type: "function", function: { name, parameters } }` structure.

The bridge translates between these two worlds, in both directions, on every request:

```
OpenClaw ──► /responses  ──► Bridge :18799 ──► /chat/completions ──► Cloudflare
         (Responses API)                    (Chat Completions)
             flat tools                      wrapped + flattened tools
             input[]                         messages[]

         ◄── SSE stream ◄───────────────────── JSON response ◄──────
    (Responses API events)                 (completions format)
```

Additionally, Cloudflare rejects tool schemas that use `oneOf`, `anyOf`, or `allOf` with a `400 Bad Input`. The bridge recursively flattens all composition keywords before forwarding.

---

## Model Recommendations

Benchmarked against connectivity, tool call accuracy, schema flattening, and instruction following. All pass the full suite except Mistral.

| Model | Score | Latency | Notes |
|---|---|---|---|
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 4/4 | 0.8s | **Recommended default.** MoE architecture — fast despite 17B params, strong tool use. |
| `@cf/zai-org/glm-4.7-flash` | 4/4 | 1.1s | Good lightweight option. Reasoning model — needs higher `max_tokens`. |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 4/4 | 1.9s | Most capable non-reasoning model. Best for complex generation tasks. |
| `@cf/moonshotai/kimi-k2.5` | 4/4 | 1.9s | Strongest reasoner. Use when depth matters more than speed. Reasoning model — needs higher `max_tokens`. |
| `@cf/meta/llama-3.2-3b-instruct` | 4/4 | 0.5s | Fastest. Suitable for simple, well-scoped tasks only. |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 3/4 | 1.6s | Fails tool calls — has a schema format incompatibility beyond `flattenSchema`. Skip for tool use. |

> **Reasoning models** (`kimi-k2.5`, `glm-4.7-flash`) generate a thinking phase before their reply. Set `max_tokens` ≥ 512 for simple prompts, ≥ 1024 for tool calls — otherwise the output budget can be exhausted before the actual response appears.

Run the benchmark yourself:
```bash
./test-model-benchmark.sh
```

---

## Repository Structure

```
packages/cf-native/
  bridge.js             # HTTP bridge — the active component. Runs on port 18799.
  lib/flatten-schema.js # Recursive JSON Schema flattener (shared)
  index.js              # OpenClaw plugin (llm_input hook — loaded but inactive in bridge setup)
  openclaw.plugin.json  # Plugin manifest
  package.json
  test-native-cf.js     # Direct Cloudflare connectivity test (no bridge)
test-clawflare.sh       # E2E smoke test — cf-test agent through bridge
test-browser-tool.sh    # E2E browser tool test — cf-test agent through bridge
test-tool-schema.sh     # Tool schema validation — direct to CF /chat/completions
test-model-benchmark.sh # Multi-model benchmark — scores all supported models
verify-keys.sh          # API key validity check
```

---

## Setup

### 1. Environment Variables

Add to `~/.zshrc` (or equivalent):

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="cfat_..."   # Account API Token with Workers AI → Edit permission
```

`CLOUDFLARE_API_TOKEN` must be a **Cloudflare Account API Token** (`cfat_` prefix), not a user token or Global API Key. Create it at `dash.cloudflare.com` → Account → Account API Tokens.

### 2. Install the Plugin

```bash
cp -r packages/cf-native ~/.openclaw/extensions/
```

Add `cf-native` to `plugins.allow` in `~/.openclaw/openclaw.json`:

```json
"plugins": {
  "allow": ["cf-native", "openclaw-web-search"]
}
```

### 3. Configure the Provider

In `~/.openclaw/openclaw.json`, under `models.providers`:

```json
"cf-native": {
  "api": "openai-responses",
  "apiKey": "bridge",
  "baseUrl": "http://127.0.0.1:18799",
  "models": [
    {
      "id": "@cf/meta/llama-4-scout-17b-16e-instruct",
      "name": "cf-native/@cf/meta/llama-4-scout-17b-16e-instruct",
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    {
      "id": "@cf/moonshotai/kimi-k2.5",
      "name": "cf-native/@cf/moonshotai/kimi-k2.5",
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    {
      "id": "@cf/zai-org/glm-4.7-flash",
      "name": "cf-native/@cf/zai-org/glm-4.7-flash",
      "contextWindow": 131072,
      "maxTokens": 8192
    }
  ]
}
```

`apiKey` is a placeholder — the bridge holds the real credentials from env vars.

### 4. Create Agents

```bash
# Primary agent — llama-4-scout (recommended default)
openclaw agents add cf-scout \
  --model "cf-native/@cf/meta/llama-4-scout-17b-16e-instruct" \
  --workspace ~/.openclaw/workspace \
  --non-interactive

# Heavy reasoning agent — kimi-k2.5
openclaw agents add cf-test \
  --model "cf-native/@cf/moonshotai/kimi-k2.5" \
  --workspace ~/.openclaw/workspace \
  --non-interactive
```

---

## Running

The bridge must be running before any OpenClaw agent test. The test scripts auto-start it if not already up.

```bash
# Terminal 1 — start the bridge
node packages/cf-native/bridge.js

# Terminal 2 — run tests
./verify-keys.sh          # confirm API key is valid (no bridge needed)
./test-tool-schema.sh     # tool schema flattening + Cloudflare acceptance (no bridge needed)
./test-clawflare.sh       # full OpenClaw round-trip through bridge → kimi-k2.5
./test-browser-tool.sh    # browser tool test through bridge → kimi-k2.5
./test-model-benchmark.sh # score all models across the full test battery
```

---

## How the Bridge Works

### Request (OpenClaw → Cloudflare)

| Responses API (from OpenClaw) | Chat Completions (to Cloudflare) |
|---|---|
| `input: [...]` | `messages: [...]` |
| Flat tool: `{ type, name, parameters }` | Wrapped: `{ type, function: { name, parameters } }` |
| Content blocks `[{type:"text", text:"..."}]` | Flattened to string |
| `function_call` items in history | `{ role: "assistant", tool_calls: [...] }` |
| `function_call_output` items | `{ role: "tool", tool_call_id: ..., content: ... }` |
| `max_output_tokens` | `max_tokens` |
| `stream: true` | `stream: false` (bridge handles SSE itself) |
| Tool schemas with `oneOf`/`anyOf`/`allOf` | Recursively flattened |

### Response (Cloudflare → OpenClaw)

The bridge converts the Chat Completions JSON response into the Responses API SSE event sequence that OpenClaw's parser expects. OpenClaw reads event type from `data.type` in the JSON payload, not from the SSE `event:` header.

**Text response event sequence:**
```
response.created → response.output_item.added → response.content_part.added
→ response.output_text.delta → response.output_item.done → response.completed → [DONE]
```

**Tool call event sequence:**
```
response.output_item.added → response.function_call_arguments.delta
→ response.function_call_arguments.done → response.output_item.done → response.completed → [DONE]
```

---

## Schema Flattening

`lib/flatten-schema.js` resolves JSON Schema composition keywords recursively:

- `oneOf`/`anyOf`/`allOf` → picks first non-null variant, recurses into it before merging (handles nested composition)
- `type: ["string", "null"]` → `type: "string"`
- Recurses into `properties` and `items`

---

## Note on `index.js` (Plugin Hook)

The `index.js` plugin is loaded by OpenClaw but its `llm_input` hook is **not active** in the current bridge setup. OpenClaw's `openai-responses` handler sends requests directly to the configured `baseUrl` (the bridge) without passing through plugin hooks. The bridge handles all transformation. The hook would only be relevant if Cloudflare ever adds native Responses API support for custom function tools.

---

## Fallback: OpenRouter

For Cloudflare availability issues or rate limits, Claude 3.5 Sonnet via OpenRouter is a reliable fallback:

```json
"openrouter": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "YOUR_OPENROUTER_KEY",
  "api": "openai-responses"
}
```
