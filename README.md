# 🦞 Clawflare

**Clawflare** is a production-grade bridge and extension suite for [OpenClaw](https://openclaw.ai), specifically designed to enable seamless integration with Cloudflare's Native AI Workers (`@cf`).

It provides a robust middleware layer that handles the strict JSON schema requirements of Cloudflare's inference API, ensuring that complex tool definitions (common in MCP and OpenClaw) are correctly flattened and sanitized before being sent to models like `kimi-k2.5`.

## 🚀 Features

- **Native Cloudflare Support**: Directly targets the `@cf` namespace with optimized payload handling.
- **Recursive Schema Flattening**: Automatically resolves `oneOf`, `anyOf`, and `allOf` composition keywords which are often rejected by the Cloudflare AI API.
- **Type Sanitization**: Handles array-based type definitions (e.g., `["string", "null"]`) to match the expected Cloudflare input format.
- **Automatic Model Prefixes**: Ensures model IDs are correctly prefixed with `@cf/` if omitted.
- **Tool Call Interception**: Sanitizes tool parameters in real-time to prevent `400 Bad Input` errors during complex agent tasks.

## 📦 Repository Structure

- `packages/cf-native/`: The core OpenClaw extension.
  - `index.ts`: Source code with the robust `flattenSchema` logic.
  - `openclaw.plugin.json`: Plugin manifest for OpenClaw.
- `test-clawflare.sh`: A utility script to verify the bridge and model connectivity.

## 🛠 Installation

1. Copy the `packages/cf-native` directory to your OpenClaw extensions folder:
   ```bash
   cp -r packages/cf-native ~/.openclaw/extensions/
   ```

2. Configure your `openclaw.json` to use the Cloudflare provider:
   ```json
   "providers": {
     "cloudflare": {
       "baseUrl": "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1",
       "apiKey": "YOUR_CF_AI_TOKEN",
       "api": "openai-responses"
     }
   }
   ```

3. Restart the OpenClaw gateway:
   ```bash
   openclaw gateway restart
   ```

## 🧪 Testing

Run the included test script to verify that your agent can communicate through the bridge:

```bash
./test-clawflare.sh
```

## 🔧 Why is this needed?

Cloudflare's AI Workers API has strict validation rules for JSON schemas in tool definitions. Many advanced agents generate schemas using modern JSON Schema features (like composition keywords) that Cloudflare does not natively support. Clawflare acts as a "smart proxy" within OpenClaw to translate these complex schemas into a format Cloudflare accepts, preventing the agent from stalling during tool execution.

---
Built with 🖤 by [Divinci AI](https://github.com/Divinci-AI)
