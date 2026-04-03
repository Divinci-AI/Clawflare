function flattenSchema(schema: any): any {
  if (typeof schema !== 'object' || schema === null) return schema;
  
  let clean = Array.isArray(schema) ? [...schema] : { ...schema };

  // Handle composition keywords (Cloudflare doesn't like them)
  if (clean.oneOf || clean.anyOf || clean.allOf) {
    const list = clean.oneOf || clean.anyOf || clean.allOf;
    // Prefer the first non-null type schema
    const first = list.find((s: any) => s.type && s.type !== 'null') || list[0];
    
    // Merge properties from the choice back into the root
    delete clean.oneOf;
    delete clean.anyOf;
    delete clean.allOf;
    Object.assign(clean, first);
  }

  // Cloudflare doesn't support array of types
  if (Array.isArray(clean.type)) {
    clean.type = clean.type.find((t: any) => t !== 'null') || clean.type[0];
  }

  // Recursively flatten properties
  if (clean.properties) {
    const newProps: any = {};
    for (const key in clean.properties) {
      newProps[key] = flattenSchema(clean.properties[key]);
    }
    clean.properties = newProps;
  }

  // Recursively flatten items for arrays
  if (clean.items) {
    clean.items = flattenSchema(clean.items);
  }

  // Ensure type is set if properties exist
  if (clean.properties && !clean.type) {
    clean.type = 'object';
  }

  return clean;
}

const cfNativePlugin = {
  id: 'cf-native',
  name: 'Clawflare Native',
  hooks: {
    async llm_input(event: any, ctx: any) {
      if (ctx.provider !== 'cf-native') return;

      const payload = event.payload;
      const supported = ['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'response_format'];
      const clean: any = {};
      
      for (const k of supported) {
        if (payload[k] !== undefined && payload[k] !== null) clean[k] = payload[k];
      }

      if (clean.model && !clean.model.startsWith('@cf/')) {
        clean.model = '@cf/' + clean.model;
      }

      if (Array.isArray(clean.tools)) {
        clean.tools = clean.tools.map((tool: any) => {
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
  }
};

export default cfNativePlugin;

export const register = (ctx: any) => {
  ctx.activate(cfNativePlugin);
};
