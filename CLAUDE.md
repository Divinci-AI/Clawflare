# Clawflare — CLAUDE.md

## Project Overview

**Clawflare** is an OpenClaw plugin and bridge suite that enables OpenClaw agents to use Cloudflare's Native AI Workers (`@cf` namespace), specifically `@cf/moonshotai/kimi-k2.5`.

## Why a Bridge is Required

OpenClaw's `openai-responses` API always sends requests to `/responses` (OpenAI Responses API format) using a flat tool structure `{ type, name, description, parameters }`. Cloudflare's `/responses` endpoint does **not** support custom function tools — it only supports its built-in tool types (web_search, computer_use).

Cloudflare's `/chat/completions` endpoint **does** support custom function tools with the wrapped format `{ type: "function", function: { name, description, parameters } }`. The bridge (`bridge.js`) translates between these two worlds in both directions.

```
OpenClaw → /responses (Responses API format, flat tools)
         → Bridge 127.0.0.1:18799
         → Cloudflare /chat/completions (Chat Completions format, wrapped tools)
         ← Bridge translates response back to Responses API SSE event stream
         ← OpenClaw receives payloads
```

## Repository Layout

```
packages/clawflare/
  index.js              # OpenClaw plugin — llm_input hook (schema flattening for direct use)
  bridge.js             # HTTP bridge: Responses API ↔ Chat Completions, port 18799
  lib/flatten-schema.js # Shared recursive JSON Schema flattener (no oneOf/anyOf/allOf)
  openclaw.plugin.json  # Plugin manifest
  package.json          # Version and engine requirements
  test-native-cf.js     # Direct Cloudflare connectivity test (no bridge)
test-clawflare.sh       # E2E smoke test — cf-test agent via bridge
test-browser-tool.sh    # E2E browser tool test — cf-test agent via bridge
test-tool-schema.sh     # E2E tool schema test — direct to CF /chat/completions
verify-keys.sh          # API key validity check
```

## OpenClaw Configuration

**Provider** (`~/.openclaw/openclaw.json`):
```json
"clawflare": {
  "api": "openai-responses",
  "apiKey": "bridge",
  "baseUrl": "http://127.0.0.1:18799"
}
```
The bridge holds the real Cloudflare credentials from env vars.

**Agent** (`cf-test`):
- Model: `clawflare/@cf/moonshotai/kimi-k2.5`
- Use `--agent cf-test` for all Cloudflare tests

## Required Environment Variables

```bash
export CLOUDFLARE_ACCOUNT_ID="14a6fa23390363382f378b5bd4a0f849"
export CLOUDFLARE_API_TOKEN="<account-api-token-with-workers-ai-edit>"  # cfat_... prefix
```

The `CLOUDFLARE_API_TOKEN` must be a **Cloudflare Account API Token** (not a user token, not a Global API Key) with **Workers AI → Edit** permission.

## Development Workflow

```bash
# 1. Start the bridge (required for OpenClaw agent tests)
node packages/clawflare/bridge.js

# 2. In another terminal — run tests
./test-tool-schema.sh   # validates flattenSchema + Cloudflare tool acceptance (no bridge needed)
./test-clawflare.sh     # full OpenClaw round-trip via bridge (auto-starts bridge if not running)
./test-browser-tool.sh  # browser tool via bridge (auto-starts bridge if not running)
./verify-keys.sh        # confirm API key is valid
```

The test scripts auto-start the bridge if it isn't already running.

## Core Components

### `lib/flatten-schema.js`
Recursively resolves `oneOf`/`anyOf`/`allOf` composition keywords that Cloudflare rejects.
- Picks the first non-null variant and calls `flattenSchema(first)` before merging (so nested composition is also resolved).
- Normalises `type: ["string", "null"]` → `type: "string"`.
- Recurses into `properties` and `items`.

### `bridge.js`
Full bidirectional format adapter running on port 18799:

**Request direction (OpenClaw → Cloudflare):**
- `input[]` (Responses API) → `messages[]` (Chat Completions), flattening content blocks to strings
- Flat tools `{type, name, parameters}` → wrapped `{type:"function", function:{name, parameters}}`
- Applies `flattenSchema` to all tool parameters
- Forces `stream: false` to Cloudflare (bridge handles streaming itself)

**Response direction (Cloudflare → OpenClaw):**
- Translates Chat Completions response → Responses API SSE event sequence
- SSE parser in OpenClaw reads `data.type` (JSON field), not `event:` header
- Event sequence: `response.created` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta` → `response.output_item.done` → `response.completed` → `[DONE]`
- Tool calls use: `response.output_item.added` → `response.function_call_arguments.delta` → `response.function_call_arguments.done` → `response.output_item.done` → `response.completed`

### `index.js` (plugin hook)
The OpenClaw plugin hook (`llm_input`) is still registered but currently inactive for the bridge-based setup (the bridge handles all transformation). It would be used if Cloudflare ever adds proper Responses API support for custom function tools.

## Security Notes

- Never commit real API tokens. Credentials come from `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` env vars.
- `CLOUDFLARE_API_TOKEN` must be an Account API Token (`cfat_` prefix) — rotate immediately if ever committed to git.
- The bridge uses `apiKey: "bridge"` as a placeholder in openclaw.json — the real key is only in the env.
