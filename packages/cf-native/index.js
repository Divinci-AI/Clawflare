function flattenSchema(schema) {
    if (typeof schema !== 'object' || schema === null)
        return schema;
    const clean = Array.isArray(schema) ? [] : { ...schema };
    if (clean.oneOf || clean.anyOf || clean.allOf) {
        const list = clean.oneOf || clean.anyOf || clean.allOf;
        const first = list.find(s => s.type && s.type !== 'null') || list[0];
        Object.assign(clean, first);
        delete clean.oneOf;
        delete clean.anyOf;
        delete clean.allOf;
    }
    if (Array.isArray(clean.type))
        clean.type = clean.type.find(t => t !== 'null') || clean.type[0];
    if (clean.properties) {
        for (const key in clean.properties)
            clean.properties[key] = flattenSchema(clean.properties[key]);
    }
    if (clean.items)
        clean.items = flattenSchema(clean.items);
    if (clean.properties && !clean.type)
        clean.type = 'object';
    return clean;
}
const cfNativePlugin = {
    id: 'cf-native',
    name: 'Clawflare Native',
    hooks: {
        async llm_input(event, ctx) {
            // INTERCEPT ALL cf-native providers
            if (ctx.provider !== 'cf-native')
                return;
            const payload = event.payload;
            // Sanitization
            const supported = ['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'response_format'];
            const clean = {};
            for (const k of supported) {
                if (payload[k] !== undefined && payload[k] !== null)
                    clean[k] = payload[k];
            }
            if (clean.model && !clean.model.startsWith('@cf/'))
                clean.model = '@cf/' + clean.model;
            if (Array.isArray(clean.tools)) {
                clean.tools = clean.tools.map(tool => {
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
            // MUTATE EVENT PAYLOAD
            event.payload = clean;
        }
    }
};
export default cfNativePlugin;
