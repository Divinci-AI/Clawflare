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
        if (block.type === 'image_url') return ''; // drop images — CF doesn't support them
        return block.text || block.content || '';
      })
      .join('');
  }
  return String(content || '');
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
      messages.push({ role: 'user', content: item });
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
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      });
    } else {
      // Regular role+content message
      flushToolCalls();
      messages.push({ role: item.role || 'user', content: flattenContent(item.content) });
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
      console.log(`→ CF ${outgoing.model} msgs=${msgCount} tools=[${toolNames}] max_tokens=${outgoing.max_tokens ?? 'unset'}`);

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
