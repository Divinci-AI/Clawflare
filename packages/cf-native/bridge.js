const http = require('http');
const https = require('https');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('❌ Clawflare Bridge Error: Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

function flattenSchema(schema) {
  if (typeof schema !== 'object' || schema === null) return schema;
  const clean = Array.isArray(schema) ? [] : { ...schema };

  if (clean.oneOf || clean.anyOf || clean.allOf) {
    const list = clean.oneOf || clean.anyOf || clean.allOf;
    const first = list.find(s => s.type && s.type !== 'null') || list[0];
    Object.assign(clean, first);
    delete clean.oneOf; delete clean.anyOf; delete clean.allOf;
  }

  if (Array.isArray(clean.type)) {
    clean.type = clean.type.find(t => t !== 'null') || clean.type[0];
  }

  if (clean.properties) {
    for (const key in clean.properties) {
      clean.properties[key] = flattenSchema(clean.properties[key]);
    }
  }

  if (clean.items) {
    clean.items = flattenSchema(clean.items);
  }

  if (clean.properties && !clean.type) clean.type = 'object';
  return clean;
}

function sanitize(payload) {
  const messages = payload.messages || (payload.input ? [{ role: 'user', content: payload.input }] : []);
  const clean = {
    model: payload.model,
    messages: messages,
    stream: payload.stream || false
  };
  
  if (payload.max_tokens || payload.max_output_tokens) {
    clean.max_tokens = payload.max_tokens || payload.max_output_tokens;
  }

  if (clean.model) {
    let id = clean.model.split('/').pop();
    if (id === 'kimi-k2.5') id = 'moonshotai/kimi-k2.5';
    if (!id.startsWith('@cf/')) id = '@cf/' + id;
    clean.model = id;
  }

  if (Array.isArray(payload.tools)) {
    clean.tools = payload.tools.map(tool => {
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
    });
  }
  return clean;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      if (!body) return res.end();
      const outgoing = sanitize(JSON.parse(body));
      const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;
      
      const cfReq = https.request(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }, (cfRes) => {
        res.writeHead(cfRes.statusCode, cfRes.headers);
        cfRes.pipe(res);
      });

      cfReq.on('error', (err) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });

      cfReq.write(JSON.stringify(outgoing));
      cfReq.end();
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(18799, '127.0.0.1', () => {
  console.log('Clawflare Bridge active on http://127.0.0.1:18799');
});
