/**
 * Clawflare Bridge
 *
 * Sits between OpenClaw and Cloudflare, translating in both directions:
 *   OpenClaw  →  Responses API format (input[], flat tools)
 *   Bridge    →  Chat Completions format (messages[], wrapped tools) → Cloudflare /ai/v1/chat/completions
 *   Bridge    ←  Chat Completions response
 *   OpenClaw  ←  Responses API response format
 *
 * This is necessary because:
 *   - OpenClaw's openai-responses API always sends to /responses with flat tool format
 *   - Cloudflare's /responses endpoint does not support custom function tools
 *   - Cloudflare's /chat/completions endpoint does support custom function tools
 */

const http = require('http');
const https = require('https');
const flattenSchema = require('./lib/flatten-schema');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_KEY = process.env.CLOUDFLARE_API_TOKEN;

if (!ACCOUNT_ID || !API_KEY) {
  console.error('❌ Clawflare Bridge: Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

const CF_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;

// ---------------------------------------------------------------------------
// Request transformation: Responses API → Chat Completions
// ---------------------------------------------------------------------------

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Content blocks: [{type:"text", text:"..."}, ...] → join as plain string
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block.type === 'text') return block.text || '';
        if (block.type === 'image_url') {
          console.warn('  ⚠️  image_url block dropped — Cloudflare /chat/completions does not support vision inputs');
          return '';
        }
        return block.text || block.content || '';
      })
      .join('');
  }
  return String(content || '');
}

// OpenClaw injects periodic heartbeat instructions as user messages:
//   "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly..."
// kimi-k2.5 can't execute this (the file is in OpenClaw's workspace, not CF) and
// returns empty content. Strip it — it's an OpenClaw-internal housekeeping message.
const HEARTBEAT_RE = /^Read HEARTBEAT\.md if it exists/i;

// OpenClaw wraps user messages in a metadata envelope:
//   Sender (untrusted metadata):
//   ```json
//   { "label": "openclaw-tui", ... }
//   ```
//   [Sat 2026-04-04 01:11 PDT] actual user message here
//
// Models like kimi-k2.5 see this as an internal protocol message and return
// empty content (finish_reason=stop, no text) — causing a silent stall.
// This function extracts just the actual user message after the JSON block.
function unwrapMetadata(content) {
  if (typeof content !== 'string') return content;
  if (HEARTBEAT_RE.test(content.trim())) {
    console.log('  ↳ heartbeat message stripped');
    return null; // caller should skip this message
  }
  if (!content.includes('(untrusted metadata)')) return content;
  // Split on ``` — the actual message is after the last closing ```
  const parts = content.split('```');
  if (parts.length < 3) return content;
  const afterBlock = parts[parts.length - 1];
  // Strip leading whitespace and optional timestamp [Day YYYY-MM-DD HH:MM TZ]
  const actual = afterBlock.replace(/^\s+/, '').replace(/^\[.*?\]\s*/, '').trim();
  if (actual) {
    console.log(`  ↳ metadata envelope unwrapped: "${actual.slice(0, 80)}"`);
    return actual;
  }
  return content;
}

function toMessages(input) {
  if (!input) return [];
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];

  const messages = [];
  let pendingToolCalls = [];

  function flushToolCalls() {
    if (pendingToolCalls.length > 0) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
      pendingToolCalls = [];
    }
  }

  for (const item of input) {
    if (typeof item === 'string') {
      flushToolCalls();
      const c = unwrapMetadata(item);
      if (c !== null) messages.push({ role: 'user', content: c });
    } else if (item.type === 'function_call') {
      // Responses API sends consecutive tool calls as separate items; Chat Completions
      // batches them into a single assistant message with tool_calls[].
      pendingToolCalls.push({
        id: item.call_id || item.id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' }
      });
    } else if (item.type === 'function_call_output') {
      flushToolCalls();
      // OpenClaw may encode call_id as "call_abc|fc_abc" (its internal format).
      // Cloudflare only needs the actual call ID before the pipe.
      const toolCallId = (item.call_id || '').split('|')[0] || item.call_id;
      // Truncate large tool outputs (e.g. browser HTML dumps) — they can be 50KB+.
      // kimi-k2.5 with 20k tokens of browser output in context exhausts its reasoning
      // budget before producing any actual reply, causing a silent empty response.
      const MAX_TOOL_OUTPUT = 12000;
      const rawOutput = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      const content = rawOutput.length > MAX_TOOL_OUTPUT
        ? rawOutput.slice(0, MAX_TOOL_OUTPUT) + `\n[... truncated ${rawOutput.length - MAX_TOOL_OUTPUT} chars]`
        : rawOutput;
      if (rawOutput.length > MAX_TOOL_OUTPUT) {
        console.log(`  ↳ tool output truncated: ${rawOutput.length} → ${MAX_TOOL_OUTPUT} chars`);
      }
      messages.push({ role: 'tool', tool_call_id: toolCallId, content });
    } else {
      // Regular role+content message
      flushToolCalls();
      const rawContent = flattenContent(item.content);
      const content = (item.role === 'user' || !item.role) ? unwrapMetadata(rawContent) : rawContent;
      if (content !== null) messages.push({ role: item.role || 'user', content });
    }
  }

  flushToolCalls();
  return messages;
}

function toWrappedTool(tool) {
  // Responses API flat format: { type: "function", name, description, parameters, strict }
  // Chat Completions format:   { type: "function", function: { name, description, parameters } }
  if (tool.type === 'function' && !tool.function) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: flattenSchema(tool.parameters || { type: 'object', properties: {} })
      }
    };
  }
  // Already in Chat Completions format — just flatten the schema
  if (tool.type === 'function' && tool.function) {
    return {
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: flattenSchema(tool.function.parameters || { type: 'object', properties: {} })
      }
    };
  }
  return tool;
}

const SUPPORTED = ['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'response_format'];

function toCompletionsPayload(raw) {
  const payload = { ...raw };

  // Translate Responses API fields to Chat Completions fields
  if (!payload.messages && payload.input !== undefined) {
    payload.messages = toMessages(payload.input);
  }
  // Responses API top-level `instructions` field = system prompt.
  // Prepend as a system message if not already present in messages.
  if (payload.instructions && Array.isArray(payload.messages)) {
    const hasSystem = payload.messages.some(m => m.role === 'system');
    if (!hasSystem) {
      payload.messages = [{ role: 'system', content: payload.instructions }, ...payload.messages];
    }
  }
  if (payload.max_output_tokens && !payload.max_tokens) {
    payload.max_tokens = payload.max_output_tokens;
  }

  // Whitelist fields
  const clean = {};
  for (const k of SUPPORTED) {
    if (payload[k] !== undefined && payload[k] !== null) clean[k] = payload[k];
  }

  // Always disable streaming — bridge reads the full response body as JSON
  clean.stream = false;

  // Ensure @cf/ model prefix
  if (clean.model && !clean.model.startsWith('@cf/')) {
    clean.model = '@cf/' + clean.model;
  }

  // Context window guard — very long conversations cause nondeterministic behavior
  // in reasoning models (108 messages → 30k tokens → kimi returns empty unpredictably).
  // Keep: all system messages + last MAX_RECENT non-system messages.
  // Tool call / tool output pairs are preserved by keeping an even window.
  if (Array.isArray(clean.messages) && clean.messages.length > 0) {
    const MAX_RECENT = 40;
    const system = clean.messages.filter(m => m.role === 'system');
    const nonSystem = clean.messages.filter(m => m.role !== 'system');
    if (nonSystem.length > MAX_RECENT) {
      const trimmed = nonSystem.slice(-MAX_RECENT);
      // Don't start with a tool message — it references a prior assistant tool_call
      // that got cut. Advance past any leading tool messages.
      let start = 0;
      while (start < trimmed.length && trimmed[start].role === 'tool') start++;
      clean.messages = [...system, ...trimmed.slice(start)];
      console.log(`  ↳ context trimmed: ${nonSystem.length} → ${clean.messages.length - system.length} non-system msgs`);
    }
  }

  // Reasoning models (kimi-k2.5, glm-4) spend tokens on an internal thinking phase
  // before producing visible output. If max_tokens is too low they exhaust the budget
  // during reasoning and return an empty message (finish_reason: "length") with no
  // content — which looks like a stall to the user. Enforce a safe minimum.
  const isReasoningModel = clean.model?.includes('kimi') || clean.model?.includes('glm-4');
  const MIN_REASONING_TOKENS = 4096;
  if (isReasoningModel && (!clean.max_tokens || clean.max_tokens < MIN_REASONING_TOKENS)) {
    clean.max_tokens = MIN_REASONING_TOKENS;
  }

  // Wrap and flatten all tools (also handle tools from original raw payload in case
  // they were under a different key before whitelist normalisation)
  const rawTools = payload.tools || raw.tools;
  if (Array.isArray(rawTools) && rawTools.length > 0) {
    clean.tools = rawTools.map(toWrappedTool);
  } else {
    delete clean.tools;
  }

  return clean;
}

// ---------------------------------------------------------------------------
// Response transformation: Chat Completions → Responses API SSE events
// ---------------------------------------------------------------------------

function buildResponsesOutput(choice) {
  const output = [];
  const toolCalls = choice.message?.tool_calls?.filter(tc => tc?.function?.name);

  if (toolCalls?.length > 0) {
    for (const tc of toolCalls) {
      const callId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      output.push({
        type: 'function_call',
        id: callId,
        call_id: callId,
        name: tc.function.name,
        arguments: tc.function.arguments || '{}'
      });
    }
  } else {
    const msgId = `msg_${Date.now()}`;
    const text = choice.message?.content || '';
    output.push({
      type: 'message',
      id: msgId,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }]
    });
  }
  return output;
}

function buildResponsesBody(completionsBody, output) {
  const usage = completionsBody.usage;
  return {
    id: completionsBody.id || `resp_${Date.now()}`,
    object: 'response',
    created_at: completionsBody.created || Math.floor(Date.now() / 1000),
    model: completionsBody.model,
    output,
    usage: usage ? {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens
    } : undefined
  };
}

// Emit full Responses API SSE event sequence for a completed Chat Completions response.
//
// OpenClaw's openai-responses SSE parser reads event type from data.type (JSON field),
// not from the SSE `event:` header line. Every data object must include `type`.
// State machine tracked internally by OpenClaw: c = current item, l = current content.
function writeResponsesSSE(res, completionsBody) {
  const choice = completionsBody.choices?.[0];
  if (!choice) {
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const output = buildResponsesOutput(choice);
  const responseBody = buildResponsesBody(completionsBody, output);

  // SSE helper — type MUST be in the JSON payload for OpenClaw's parser
  function sseEvent(eventType, data) {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, ...data })}\n\n`);
  }

  // 1. response.created
  sseEvent('response.created', { response: { ...responseBody, output: [] } });

  // 2. Per output item
  output.forEach((item) => {
    if (item.type === 'message') {
      const text = item.content?.[0]?.text || '';
      const msgId = item.id;

      // output_item.added: item.type='message' triggers c=item, l={type:'text',text:''}
      sseEvent('response.output_item.added', {
        item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] }
      });

      // content_part.added: d.part pushed to c.content
      sseEvent('response.content_part.added', {
        item_id: msgId,
        part: { type: 'output_text', text: '' }
      });

      // output_text.delta: l.text += d.delta, c.content[-1].text += d.delta
      if (text) {
        sseEvent('response.output_text.delta', {
          item_id: msgId,
          delta: text
        });
      }

      // output_item.done: l.text = item.content.map(...).join('')
      sseEvent('response.output_item.done', {
        item: { type: 'message', id: msgId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }
      });

    } else if (item.type === 'function_call') {
      const callId = item.call_id;
      const itemId = item.id;
      const args = item.arguments || '{}';

      // output_item.added: triggers c=item, l={type:'toolCall',id:'${call_id}|${id}',...}
      sseEvent('response.output_item.added', {
        item: { type: 'function_call', id: itemId, call_id: callId, name: item.name, arguments: '' }
      });

      // function_call_arguments.delta: l.partialJson += d.delta
      sseEvent('response.function_call_arguments.delta', {
        item_id: itemId,
        call_id: callId,
        delta: args
      });

      // function_call_arguments.done: l.partialJson = d.arguments, l.arguments = parse(...)
      sseEvent('response.function_call_arguments.done', {
        item_id: itemId,
        call_id: callId,
        arguments: args
      });

      sseEvent('response.output_item.done', {
        item: { type: 'function_call', id: itemId, call_id: callId, name: item.name, arguments: args }
      });
    }
  });

  // 3. response.completed — usage + stopReason extracted here by OpenClaw
  const usage = completionsBody.usage;
  sseEvent('response.completed', {
    response: {
      ...responseBody,
      status: 'completed',
      usage: usage ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      } : undefined
    }
  });

  res.write('data: [DONE]\n\n');
  res.end();
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      if (!body) return res.end();
      const raw = JSON.parse(body);
      const outgoing = toCompletionsPayload(raw);
      const bodyStr = JSON.stringify(outgoing);

      const toolNames = outgoing.tools?.map(t => t.function?.name || t.type).join(',') || 'none';
      const msgCount = outgoing.messages?.length ?? 0;
      // Log last message role/type to track where in the conversation we are
      const lastMsg = outgoing.messages?.[outgoing.messages.length - 1];
      const lastRole = lastMsg?.role || '?';
      const lastContent = typeof lastMsg?.content === 'string' ? lastMsg.content : '[non-string]';
      const isMetadata = lastContent.includes('untrusted metadata');
      const logContent = isMetadata ? lastContent.slice(0, 500).replace(/\n/g, '↵') : lastContent.slice(0, 80).replace(/\n/g, ' ');
      if (isMetadata) {
        console.log(`→ CF ${outgoing.model} msgs=${msgCount} tools=[${toolNames}] max_tokens=${outgoing.max_tokens ?? 'unset'}`);
        console.log(`  METADATA ENVELOPE (full):\n${lastContent.slice(0, 1000)}`);
      } else {
        console.log(`→ CF ${outgoing.model} msgs=${msgCount} last=${lastRole}:"${logContent}" tools=[${toolNames}] max_tokens=${outgoing.max_tokens ?? 'unset'}`);
      }

      // Detect if OpenClaw wants streaming — if so we'll fake SSE back to it
      const wantsStream = raw.stream === true;

      // Reasoning models (kimi-k2.5, glm-4.7-flash) generate a thinking phase before
      // responding. With large contexts (30k+ tokens) this can exceed 2 minutes.
      const isReasoning = outgoing.model?.includes('kimi') || outgoing.model?.includes('glm-4');
      const TIMEOUT_MS = isReasoning ? 180000 : 90000; // 3 min reasoning, 90s others

      const cfReq = https.request(CF_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr)
        }
      }, (cfRes) => {
        let cfBody = '';
        cfRes.on('data', (c) => { cfBody += c; });
        cfRes.on('end', () => {
          if (cfRes.statusCode !== 200) {
            console.error(`← CF error ${cfRes.statusCode}:`, cfBody.slice(0, 500));
            res.writeHead(cfRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(cfBody);
            return;
          }

          let completions;
          try {
            completions = JSON.parse(cfBody);
          } catch (e) {
            console.error('← CF response JSON parse error:', e.message, cfBody.slice(0, 200));
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'invalid JSON from Cloudflare' }));
            return;
          }

          const finishReason = completions.choices?.[0]?.finish_reason;
          const hasToolCalls = completions.choices?.[0]?.message?.tool_calls?.length > 0;
          console.log(`← CF ok finish_reason=${finishReason} tool_calls=${hasToolCalls}`);
          if (finishReason === 'length') {
            console.warn('  ⚠️  finish_reason=length — model hit max_tokens mid-reasoning. Response may be empty.');
          }

          if (wantsStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });
            writeResponsesSSE(res, completions);
          } else {
            const output = buildResponsesOutput(completions.choices[0]);
            const responsesBody = buildResponsesBody(completions, output);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsesBody));
          }
        });
      });

      // Timeout — prevents indefinite stall on slow CF responses
      cfReq.setTimeout(TIMEOUT_MS, () => {
        console.error(`← CF timeout after ${TIMEOUT_MS}ms — aborting`);
        cfReq.destroy();
        if (!res.headersSent) {
          res.writeHead(504);
          res.end(JSON.stringify({ error: `Cloudflare timeout after ${TIMEOUT_MS}ms` }));
        }
      });

      cfReq.on('error', (err) => {
        console.error('← CF request error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      cfReq.write(bodyStr);
      cfReq.end();
    } catch (err) {
      console.error('Bridge parse error:', err.message);
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

const PORT = parseInt(process.env.BRIDGE_PORT || '18799', 10);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Clawflare Bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`Forwarding to: ${CF_URL}`);
});
