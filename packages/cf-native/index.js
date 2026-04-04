const flattenSchema = require('./lib/flatten-schema');

const SUPPORTED_FIELDS = ['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'response_format'];

const hooks = {
  async llm_input(event, ctx) {
    if (ctx.provider !== 'clawflare') return;
    const payload = event.payload;
    const clean = {};
    for (const k of SUPPORTED_FIELDS) {
      if (payload[k] !== undefined && payload[k] !== null) clean[k] = payload[k];
    }
    if (clean.model && !clean.model.startsWith('@cf/')) {
      clean.model = '@cf/' + clean.model;
    }
    if (Array.isArray(clean.tools)) {
      clean.tools = clean.tools.map((tool) => {
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
    event.payload = clean;
  }
};

module.exports = {
  id: 'clawflare',
  name: 'Clawflare',
  register: function(api) {
    api.logger.info('clawflare: registered successfully');
    api.on('llm_input', hooks.llm_input);
  }
};
