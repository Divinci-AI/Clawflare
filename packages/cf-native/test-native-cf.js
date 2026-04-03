const CLOUDFLARE_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts';
const ACCOUNT_ID = '14a6fa23390363382f378b5bd4a0f849';
const API_TOKEN = 'tzg7Cb0un6dX7jSP91HKV-IQQ4l_5_u-YAiP1TNN';

function sanitizeRequest(payload) {
  const supportedFields = ['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'response_format'];
  const sanitized = {};
  for (const field of supportedFields) {
    if (payload[field] !== undefined && payload[field] !== null) {
      sanitized[field] = payload[field];
    }
  }
  if (Array.isArray(sanitized.tools) && sanitized.tools.length === 0) delete sanitized.tools;
  if (!sanitized.model.startsWith('@cf/')) {
     sanitized.model = '@cf/' + sanitized.model;
  }
  return sanitized;
}

async function test() {
  const payload = sanitizeRequest({
    model: 'meta/llama-3.1-8b-instruct',
    messages: [{ role: 'user', content: 'Hello, are you working?' }],
    stream: false
  });

  const url = `${CLOUDFLARE_BASE_URL}/${ACCOUNT_ID}/ai/v1/chat/completions`;
  console.log(`Testing URL: ${url}`);
  console.log(`Payload: ${JSON.stringify(payload, null, 2)}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('❌ Cloudflare Error:', JSON.stringify(data, null, 2));
    } else {
      console.log('✅ SUCCESS!');
      console.log('Reply:', data.choices[0].message.content);
    }
  } catch (err) {
    console.error('❌ Fetch Failed:', err);
  }
}

test();
