// Zero-dep JSON-Schema (draft-07 subset) helpers: validate, loadSchema. The single source
// for shape-checking across every model described in schema/.

import { readFileSync } from 'node:fs';

const TYPE_CHECK = {
  string: value => typeof value === 'string',
  integer: value => Number.isInteger(value),
  number: value => typeof value === 'number',
  boolean: value => typeof value === 'boolean',
  array: value => Array.isArray(value),
  object: value => value !== null && typeof value === 'object' && !Array.isArray(value),
  null: value => value === null,
};

/**
 * Validate a value against a draft-07 subset schema. Not a full validator - just enough to catch a
 * malformed or foreign document. Supports type, required, properties, additionalProperties
 * (false | subschema), items, enum, const; recurses into objects and arrays.
 * @param {*} value - the value to check.
 * @param {object} schema - the schema to check against.
 * @param {string} [path] - dotted path for nested problem messages (internal).
 * @returns {string[]} problems ([] when valid).
 */
export function validate(value, schema, path = '') {
  if (path === '' && (value === null || typeof value !== 'object' || Array.isArray(value)))
    return ['not an object'];

  const problems = [];
  const label = path || 'value';

  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some(type => TYPE_CHECK[type]?.(value))) {
      problems.push(`'${label}' must be ${types.join('|')}`);
      return problems; // wrong type: deeper checks would be noise
    }
  }
  if ('const' in schema && value !== schema.const)
    problems.push(`'${label}' must equal ${JSON.stringify(schema.const)}`);

  if (schema.enum && !schema.enum.includes(value))
    problems.push(`'${label}' must be one of ${schema.enum.join(', ')}`);

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const prefix = path ? `${path}: ` : '';
    for (const key of schema.required ?? []) {
      if (!(key in value))
        problems.push(`${prefix}missing required '${key}'`);
    }
    const properties = schema.properties ?? {};
    for (const [key, sub] of Object.entries(properties)) {
      if (value[key] == null)
        continue; // absent or null - nullability is expressed by the sub-schema's type
      problems.push(...validate(value[key], sub, path ? `${path}.${key}` : key));
    }
    const extra = schema.additionalProperties;
    if (extra === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties))
          problems.push(`${prefix}unexpected key '${key}'`);
      }
    }
    else if (extra && typeof extra === 'object') {
      for (const [key, mapValue] of Object.entries(value)) {
        if (!(key in properties))
          problems.push(...validate(mapValue, extra, path ? `${path}.${key}` : key));
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((element, index) =>
      problems.push(...validate(element, schema.items, `${path}[${index}]`)),
    );
  }
  return problems;
}

/**
 * Deep-resolve every { "$ref": "<sibling>.json" } by loading the sibling schema in its place.
 * @param {*} node - a schema node.
 * @returns {*} the node with $refs resolved.
 */
function resolveRefs(node) {
  if (Array.isArray(node))
    return node.map(resolveRefs);
  if (node !== null && typeof node === 'object') {
    if (typeof node.$ref === 'string')
      return loadSchema(node.$ref);
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolveRefs(value)]));
  }
  return node;
}

/**
 * Load a schema from schema/<name> (relative to this module) with $refs resolved.
 * @param {string} name - the schema filename, e.g. 'config.schema.json'.
 * @returns {object} the parsed, ref-resolved schema.
 */
export function loadSchema(name) {
  const schema = JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), 'utf8'));
  return resolveRefs(schema);
}
