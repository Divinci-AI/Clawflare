#!/bin/bash
# Cloudflare model benchmark — tests a suite of @cf models against the same battery
# and produces a scored comparison table.
#
# Tests (per model):
#   1. Connectivity   — does it respond at all?
#   2. Tool call      — does it call a function when explicitly asked?
#   3. Schema flatten — does our flattenSchema pipeline produce an accepted payload?
#   4. Instruction    — does it follow a precise instruction ("reply with only: PONG")?
#   5. Latency        — wall-clock time for the tool call test
#
# Each model gets a score /4 and a pass/fail per test.
set -euo pipefail

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
API_KEY="${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

# Models to benchmark — add/remove as needed
MODELS=(
  "@cf/moonshotai/kimi-k2.5"
  "@cf/zai-org/glm-4.7-flash"
  "@cf/meta/llama-4-scout-17b-16e-instruct"
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  "@cf/mistralai/mistral-small-3.1-24b-instruct"
  "@cf/meta/llama-3.2-3b-instruct"
)

echo "=== Clawflare Model Benchmark ==="
echo "Account: ${ACCOUNT_ID}"
echo "Models:  ${#MODELS[@]}"
echo ""

node - <<'JSEOF'
const https = require('https');
const flattenSchema = require('./packages/cf-native/lib/flatten-schema');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_KEY    = process.env.CLOUDFLARE_API_TOKEN;
const BASE_URL   = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;

const MODELS = process.env.BENCHMARK_MODELS
  ? process.env.BENCHMARK_MODELS.split(',')
  : [
      '@cf/moonshotai/kimi-k2.5',
      '@cf/zai-org/glm-4.7-flash',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/mistralai/mistral-small-3.1-24b-instruct',
      '@cf/meta/llama-3.2-3b-instruct',
    ];

// Reasoning models spend tokens on thinking before content — need higher max_tokens
// or the output budget is exhausted before the actual reply appears.
const REASONING_MODELS = new Set([
  '@cf/moonshotai/kimi-k2.5',
  '@cf/zai-org/glm-4.7-flash',
]);

// Shared tool definition with composition keywords that must be flattened
const RAW_TOOL_PARAMS = {
  type: 'object',
  properties: {
    query:       { anyOf: [{ type: 'string', description: 'Search query' }, { type: 'null' }] },
    max_results: { oneOf: [{ type: 'integer', minimum: 1, maximum: 10 }, { type: 'null' }] },
    filter:      { type: ['string', 'null'] }
  },
  required: ['query']
};

const TOOL = {
  type: 'function',
  function: {
    name: 'search_web',
    description: 'Search the web for information',
    parameters: flattenSchema(RAW_TOOL_PARAMS)
  }
};

function post(model, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, stream: false, ...payload });
    const start = Date.now();
    const req = https.request(BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const ms = Date.now() - start;
        resolve({ status: res.statusCode, body: data, ms });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runTests(model) {
  const results = { model, connectivity: false, toolCall: false, schemaFlatten: false, instruction: false, latencyMs: null, errors: [] };
  const isReasoning = REASONING_MODELS.has(model);
  // Reasoning models need headroom for thinking tokens before the actual reply
  const shortTokens = isReasoning ? 512 : 32;
  const toolTokens  = isReasoning ? 1024 : 256;

  // ── Test 1: Connectivity ──────────────────────────────────────────────
  try {
    const r = await post(model, { messages: [{ role: 'user', content: 'Reply with: OK' }], max_tokens: shortTokens });
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      results.connectivity = !!j.choices?.[0]?.message?.content;
    } else {
      results.errors.push(`connectivity:${r.status}`);
    }
  } catch (e) { results.errors.push(`connectivity:${e.message.slice(0,30)}`); }

  // ── Test 2 + 5: Tool Call + Latency ──────────────────────────────────
  try {
    const r = await post(model, {
      messages: [{ role: 'user', content: 'Search the web for "OpenClaw documentation". You must call the search_web function.' }],
      tools: [TOOL],
      tool_choice: { type: 'function', function: { name: 'search_web' } },
      max_tokens: toolTokens
    });
    results.latencyMs = r.ms;
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      const choice = j.choices?.[0];
      const hasToolCall = choice?.finish_reason === 'tool_calls' || choice?.message?.tool_calls?.length > 0;
      results.toolCall = hasToolCall;
      if (!hasToolCall) results.errors.push('toolCall:no_function_called');
    } else {
      const err = JSON.parse(r.body);
      results.errors.push(`toolCall:${r.status}:${JSON.stringify(err).slice(0,60)}`);
    }
  } catch (e) { results.errors.push(`toolCall:${e.message.slice(0,30)}`); }

  // ── Test 3: Schema flatten (verify no 400 from composition keywords) ──
  const complexTool = {
    type: 'function',
    function: {
      name: 'complex_tool',
      description: 'Tool with deeply nested composition',
      parameters: flattenSchema({
        type: 'object',
        properties: {
          a: { anyOf: [{ oneOf: [{ type: 'string' }, { type: 'null' }] }, { type: 'null' }] },
          b: { type: ['integer', 'null'] }
        }
      })
    }
  };
  // Verify no composition keywords survived
  const schemaStr = JSON.stringify(complexTool);
  const hasComposition = /\b(oneOf|anyOf|allOf)\b/.test(schemaStr);
  if (hasComposition) {
    results.errors.push('schemaFlatten:composition_survived');
  } else {
    try {
      const r = await post(model, {
        messages: [{ role: 'user', content: 'Call complex_tool with a="hello".' }],
        tools: [complexTool],
        max_tokens: 64
      });
      // 200 = schema accepted; anything else = rejected
      results.schemaFlatten = r.status === 200;
      if (r.status !== 200) results.errors.push(`schemaFlatten:${r.status}`);
    } catch (e) { results.errors.push(`schemaFlatten:${e.message.slice(0,30)}`); }
  }

  // ── Test 4: Instruction following ─────────────────────────────────────
  try {
    const r = await post(model, {
      messages: [{ role: 'user', content: 'Reply with only the word: PONG' }],
      max_tokens: shortTokens
    });
    if (r.status === 200) {
      const text = (JSON.parse(r.body).choices?.[0]?.message?.content || '').trim();
      results.instruction = /^pong\.?$/i.test(text);
      if (!results.instruction) results.errors.push(`instruction:got="${text.slice(0,30)}"`);
    }
  } catch (e) { results.errors.push(`instruction:${e.message.slice(0,30)}`); }

  return results;
}

function bar(score, total) {
  const filled = Math.round((score / total) * 8);
  return '█'.repeat(filled) + '░'.repeat(8 - filled);
}

function cell(pass) { return pass ? '✅' : '❌'; }

async function main() {
  const allResults = [];
  for (const model of MODELS) {
    const shortName = model.replace('@cf/', '');
    process.stdout.write(`  Testing ${shortName}...`);
    const r = await runTests(model);
    allResults.push(r);
    const score = [r.connectivity, r.toolCall, r.schemaFlatten, r.instruction].filter(Boolean).length;
    console.log(` ${score}/4`);
  }

  console.log('\n' + '─'.repeat(90));
  console.log(
    'Model'.padEnd(42) +
    'Connect  Tool  Schema  Instruct  Score  Latency'
  );
  console.log('─'.repeat(90));

  allResults
    .sort((a, b) => {
      const sa = [a.connectivity, a.toolCall, a.schemaFlatten, a.instruction].filter(Boolean).length;
      const sb = [b.connectivity, b.toolCall, b.schemaFlatten, b.instruction].filter(Boolean).length;
      return sb - sa;
    })
    .forEach((r) => {
      const score = [r.connectivity, r.toolCall, r.schemaFlatten, r.instruction].filter(Boolean).length;
      const name  = r.model.replace('@cf/', '').slice(0, 40).padEnd(40);
      const lat   = r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)}s` : '  —  ';
      console.log(
        `${name}  ` +
        `${cell(r.connectivity)}       ${cell(r.toolCall)}     ${cell(r.schemaFlatten)}      ${cell(r.instruction)}      ` +
        `${bar(score, 4)}  ${lat}`
      );
      if (r.errors.length > 0) {
        console.log(`  ${''.padEnd(40)} ↳ ${r.errors.join(', ')}`);
      }
    });

  console.log('─'.repeat(90));
  console.log('\nScore key: Connect=responds, Tool=calls function, Schema=accepts flattened schema, Instruct=follows instructions');
}

main().catch(e => { console.error('Benchmark failed:', e); process.exit(1); });
JSEOF
