// Adapt one command arg-spec (schema/commands/<cmd>.json = JSON Schema + x-cli/x-mcp) into the CLI
// parseArgs options, the MCP inputSchema, and the MCP->CLI argv. Zero-dep; the single source that
// keeps the CLI parser and the MCP tool from drifting.
import { validate } from './schema.mjs';

const flagKey = flag => flag.replace(/^--/, ''); // '--first-free' -> 'first-free'

/**
 * Build the node:util parseArgs `options` map from a spec's flag args (positionals are read from
 * parseArgs positionals, not options).
 * @param {object} spec - a command arg-spec.
 * @returns {object} the parseArgs options map, keyed by CLI flag name.
 */
export function toParseArgs(spec) {
  const options = {};
  for (const [name, entry] of Object.entries(spec['x-cli'].args)) {
    if (!entry.flag)
      continue;
    const propType = spec.properties[name].type;
    const type = propType === 'boolean' ? 'boolean' : 'string';
    const opt = entry.short ? { type, short: entry.short } : { type };
    if (propType === 'array')
      opt.multiple = true;
    options[flagKey(entry.flag)] = opt;
  }
  return options;
}

/**
 * The clean JSON Schema an MCP tool uses as its inputSchema (spec minus the non-schema keys).
 * @param {object} spec - a command arg-spec.
 * @returns {object} the inputSchema.
 */
export function mcpInputSchema(spec) {
  // Strip the tool-level keys; the tool's name/description come from mcpToolName/spec.description.
  // Property-level descriptions stay (they are the arg docs the LLM reads). CLI-only args
  // (x-cli.args[name].mcpHidden) are dropped from properties + required so no MCP client sees them.
  const { 'x-mcp': _mcp, 'x-cli': cli, $schema: _schema, $id: _id, title: _title, description: _description, ...rest } = spec;
  const hidden = new Set(Object.entries(cli.args).filter(([, entry]) => entry.mcpHidden).map(([name]) => name));
  const properties = Object.fromEntries(Object.entries(rest.properties ?? {}).filter(([name]) => !hidden.has(name)));
  const schema = { ...rest, properties };
  if (rest.required)
    schema.required = rest.required.filter(name => !hidden.has(name));
  return schema;
}

/**
 * Whether a command spec is exposed on the web (sm serve) surface. STRICT opt-in:
 * only an explicit `"x-web": true` qualifies - absence, false, or any non-boolean is
 * unexposed, so a new command can never drift onto the web surface silently (a
 * schema-lint test additionally requires the key on every spec).
 * @param {object} spec - a command arg-spec.
 * @returns {boolean} true only for an explicit x-web: true.
 */
export function webExposed(spec) {
  return spec['x-web'] === true;
}

/**
 * The MCP tool name for a spec: sm_ + the CLI path joined by underscores.
 * @param {object} spec - a command arg-spec.
 * @returns {string} e.g. 'sm_lock_claim'.
 */
export function mcpToolName(spec) {
  return `sm_${spec['x-cli'].path.join('_')}`;
}

/**
 * Build the CLI argv for a command from MCP-style args: [...path, ...flags, '--', ...positionals].
 * Validates args against the schema first (throws on a problem).
 * @param {object} spec - a command arg-spec.
 * @param {object} args - the argument values (MCP property names).
 * @returns {string[]} the CLI argv (without the leading binary).
 */
export function buildArgv(spec, args) {
  const problems = validate(args, mcpInputSchema(spec));
  if (problems.length)
    throw new Error(`invalid args for ${spec['x-cli'].path.join(' ')}: ${problems.join('; ')}`);
  const entries = Object.entries(spec['x-cli'].args);
  const flags = [];
  for (const [name, entry] of entries) {
    if (!entry.flag || args[name] == null || args[name] === false)
      continue;
    const token = entry.short ? `-${entry.short}` : entry.flag;
    if (spec.properties[name].type === 'boolean')
      flags.push(token);
    else flags.push(token, String(args[name]));
  }
  const positionalEntries = entries
    .filter(([, entry]) => entry.positional != null)
    .sort((left, right) => left[1].positional - right[1].positional);
  const positionals = [];
  let sawGap = false;
  for (const [name] of positionalEntries) {
    if (args[name] == null) {
      sawGap = true; // trailing-absent is fine; only a later present value makes it a real gap
      continue;
    }
    if (sawGap)
      throw new Error(`positional gap for ${spec['x-cli'].path.join(' ')}: '${name}' is set but an earlier positional is absent`);
    const value = args[name];
    if (Array.isArray(value))
      positionals.push(...value.map(String));
    else positionals.push(String(value));
  }
  return [...spec['x-cli'].path, ...flags, ...(positionals.length ? ['--', ...positionals] : [])];
}
