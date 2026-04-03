# Cloudflare AI Workers Integration Summary

This document summarizes the technical challenges and solutions discovered while integrating Cloudflare's Native AI Workers (`@cf`) into OpenClaw.

## 🛠 Integration Journey

### 1. Schema Flattening (The "400 Bad Input" Problem)
Cloudflare's AI Run API and its OpenAI-compatible bridge are strictly constrained regarding JSON Schema.
- **Challenge**: Standard MCP and OpenClaw tool definitions use complex JSON Schema features like `oneOf`, `anyOf`, and `allOf`. Cloudflare's API rejects these with a `400 Bad Input` error.
- **Solution**: Developed a recursive `flattenSchema` utility within the `cf-native` extension to resolve these keywords into a simple, flat structure that Cloudflare accepts.

### 2. Payload Transformation
- **Challenge**: The OpenAI-compatible bridge on Cloudflare often expects tools to be formatted differently than standard OpenAI (e.g., omitting the `function` wrapper).
- **Solution**: Implemented logic in the `cf-native` plugin hooks to intercept `llm_input` and transform the tool definitions into the flatter format preferred by the native AI Run API.

### 3. Authentication & Configuration
- **Challenge**: Encountered persistent `401 Unauthorized` errors with multiple candidate keys.
- **Solution**: Verified multiple keys from `.zshrc` and environment files using a custom verification script (`verify-keys.sh`). 
- **Active Working Key**: set via `CLOUDFLARE_API_TOKEN` env var (staging token; rotate if previously committed).
- **Account ID**: set via `CLOUDFLARE_ACCOUNT_ID` env var.

### 4. Bridge Proxy (Architecture)
- **Challenge**: OpenClaw's internal `openai-responses` API sometimes bypasses standard plugin hooks, preventing schema cleaning.
- **Attempted Solution**: Built a local Node.js proxy (`bridge.js`) to act as a middleware between OpenClaw and Cloudflare. This bridge successfully handled the transformation but faced connection reliability issues within the local environment.

## 📍 Current Status
The system is currently configured to connect **directly** to Cloudflare using the verified working staging key. The `cf-native` plugin is registered and active, providing schema flattening support for models like `kimi-k2.5`.

---
*Created on April 2, 2026*
