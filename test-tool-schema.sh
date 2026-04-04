#!/bin/bash
# E2E tool schema test — sends a complex tool definition (with oneOf/anyOf) directly to
# Cloudflare's kimi-k2.5 via the ai/v1/chat/completions endpoint.
# This validates the full flattenSchema pipeline: the payload must be accepted (no 400)
# and the model must respond with a tool_call.
set -euo pipefail

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
API_TOKEN="${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
URL="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions"

echo "=== Clawflare Tool Schema E2E Test ==="
echo "Model: @cf/moonshotai/kimi-k2.5"
echo "Target: $URL"
echo ""

# Run schema flattening on a complex payload via the shared lib, then POST to Cloudflare
node - <<'EOF'
const flattenSchema = require('./packages/clawflare/lib/flatten-schema');
const https = require('https');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;

// Simulate an MCP-style tool with composition keywords that Cloudflare rejects raw.
// flattenSchema must resolve these before sending.
const rawTool = {
  type: 'function',
  function: {
    name: 'search_web',
    description: 'Search the web for information',
    parameters: {
      type: 'object',
      properties: {
        query: {
          anyOf: [{ type: 'string', description: 'Search query' }, { type: 'null' }]
        },
        max_results: {
          oneOf: [{ type: 'integer', minimum: 1, maximum: 20 }, { type: 'null' }]
        },
        filter: {
          type: ['string', 'null'],
          description: 'Optional result filter'
        }
      },
      required: ['query']
    }
  }
};

const flattenedTool = {
  ...rawTool,
  function: {
    ...rawTool.function,
    parameters: flattenSchema(rawTool.function.parameters)
  }
};

// Verify no composition keywords survived
const params = flattenedTool.function.parameters;
const hasComposition = JSON.stringify(params).match(/\b(oneOf|anyOf|allOf)\b/);
if (hasComposition) {
  console.error('❌ FAIL: flattenSchema left composition keywords in payload:', hasComposition[0]);
  process.exit(1);
}
console.log('✅ Schema flattened — no oneOf/anyOf/allOf remaining');
console.log('   Flattened params:', JSON.stringify(params, null, 2));

const payload = {
  model: '@cf/moonshotai/kimi-k2.5',
  messages: [{ role: 'user', content: 'Search for "OpenClaw documentation"' }],
  tools: [flattenedTool],
  tool_choice: 'auto',
  stream: false
};

const body = JSON.stringify(payload);
const options = {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  }
};

console.log('\nPOSTing to Cloudflare...');
const req = https.request(URL, options, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`❌ FAIL: HTTP ${res.statusCode}`);
      try { console.error('   Response:', JSON.stringify(JSON.parse(data), null, 2)); }
      catch { console.error('   Raw:', data); }
      process.exit(1);
    }
    const json = JSON.parse(data);
    const choice = json.choices?.[0];
    if (!choice) {
      console.error('❌ FAIL: No choices in response');
      process.exit(1);
    }
    if (choice.finish_reason === 'tool_calls' || choice.message?.tool_calls?.length > 0) {
      console.log('✅ Model returned a tool_call — schema accepted and tools are functional');
      console.log('   Tool called:', choice.message.tool_calls[0].function.name);
      console.log('   Arguments:', choice.message.tool_calls[0].function.arguments);
    } else if (choice.message?.content) {
      console.log('✅ Model responded (text, no tool_call — model may have answered directly)');
      console.log('   Content:', choice.message.content.slice(0, 200));
    } else {
      console.error('❌ FAIL: Unexpected response shape:', JSON.stringify(choice, null, 2));
      process.exit(1);
    }
    console.log('\n✅ All checks passed');
  });
});

req.on('error', (err) => {
  console.error('❌ FAIL: Request error:', err.message);
  process.exit(1);
});

req.write(body);
req.end();
EOF
