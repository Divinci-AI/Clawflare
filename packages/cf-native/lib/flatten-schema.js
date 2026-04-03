/**
 * Recursively flattens JSON Schema composition keywords (oneOf, anyOf, allOf)
 * into a simple structure that Cloudflare's AI inference API accepts.
 *
 * Cloudflare rejects schemas with composition keywords with 400 Bad Input.
 * This utility picks the first non-null variant and merges it, recursing
 * into the selected variant so nested composition is also resolved.
 */
function flattenSchema(schema) {
  if (typeof schema !== 'object' || schema === null) return schema;
  let clean = Array.isArray(schema) ? [...schema] : { ...schema };

  if (clean.oneOf || clean.anyOf || clean.allOf) {
    const list = clean.oneOf || clean.anyOf || clean.allOf;
    const first = list.find((s) => s.type && s.type !== 'null') || list[0];
    delete clean.oneOf;
    delete clean.anyOf;
    delete clean.allOf;
    // Recurse into the selected variant before merging so nested composition
    // keywords in `first` are also resolved rather than re-introduced.
    Object.assign(clean, flattenSchema(first));
  }

  if (Array.isArray(clean.type)) {
    clean.type = clean.type.find((t) => t !== 'null') || clean.type[0];
  }

  if (clean.properties) {
    const newProps = {};
    for (const key in clean.properties) {
      newProps[key] = flattenSchema(clean.properties[key]);
    }
    clean.properties = newProps;
  }

  if (clean.items) clean.items = flattenSchema(clean.items);

  if (clean.properties && !clean.type) clean.type = 'object';

  return clean;
}

module.exports = flattenSchema;
