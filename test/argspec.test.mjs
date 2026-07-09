import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { buildArgv, mcpInputSchema, mcpToolName, toParseArgs } from '../lib/argspec.mjs';

import { readdirSync } from 'node:fs';
import { loadSchema } from '../lib/schema.mjs';
import { ROUTES } from '../lib/router.mjs';

const SPEC = {
  '$schema': 'http://json-schema.org/draft-07/schema#',
  '$id': 'https://slot-machine/commands/lock-claim.json',
  'title': 'lock claim',
  'description': 'claim a lock',
  'x-mcp': true,
  'type': 'object',
  'required': ['name'],
  'additionalProperties': false,
  'properties': {
    name: { type: 'string' },
    task: { type: 'string' },
    slot: { type: 'string' },
    wait: { type: 'boolean' },
    firstFree: { type: 'boolean' },
  },
  'x-cli': {
    path: ['lock', 'claim'],
    args: {
      name: { positional: 0 },
      task: { positional: 1 },
      slot: { flag: '--slot', short: 's' },
      wait: { flag: '--wait' },
      firstFree: { flag: '--first-free', short: 'f' },
    },
  },
};

test('toParseArgs: flag args only, keyed by flag name, with types + shorts', () => {
  assert.deepEqual(toParseArgs(SPEC), {
    'slot': { type: 'string', short: 's' },
    'wait': { type: 'boolean' },
    'first-free': { type: 'boolean', short: 'f' },
  });
});

test('mcpInputSchema: strips tool-level keys, keeps the arg schema', () => {
  const schema = mcpInputSchema(SPEC);
  assert.equal(schema['x-mcp'], undefined);
  assert.equal(schema['x-cli'], undefined);
  assert.equal(schema.$id, undefined);
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.title, undefined);
  assert.equal(schema.description, undefined);
  assert.deepEqual(schema.required, ['name']);
  assert.equal(schema.properties.name.type, 'string'); // property-level kept
});

test('mcpToolName: sm_ + path joined by _', () => {
  assert.equal(mcpToolName(SPEC), 'sm_lock_claim');
});

test('buildArgv: path, short flags, -- then positionals in index order', () => {
  assert.deepEqual(
    buildArgv(SPEC, { name: 'browser', task: 'shot', slot: 'a', wait: true, firstFree: true }),
    ['lock', 'claim', '-s', 'a', '--wait', '-f', '--', 'browser', 'shot'],
  );
  assert.deepEqual(buildArgv(SPEC, { name: 'browser' }), ['lock', 'claim', '--', 'browser']);
});

test('buildArgv: throws on a missing required arg', () => {
  assert.throws(() => buildArgv(SPEC, { slot: 'a' }), /name/);
});

test('buildArgv round-trips through parseArgs(toParseArgs)', () => {
  const args = { name: 'browser', slot: 'a', wait: true };
  const argv = buildArgv(SPEC, args);
  const cliArgs = argv.slice(2); // drop the path
  const { values, positionals } = parseArgs({ args: cliArgs, options: toParseArgs(SPEC), allowPositionals: true });
  assert.equal(values.slot, 'a');
  assert.equal(values.wait, true);
  assert.deepEqual(positionals, ['browser']);
});

test('buildArgv: drops a trailing absent positional but throws on a non-trailing gap', () => {
  const twoPos = {
    'type': 'object',
    'additionalProperties': false,
    'properties': { first: { type: 'string' }, second: { type: 'string' } },
    'x-cli': { path: ['demo'], args: { first: { positional: 0 }, second: { positional: 1 } } },
  };
  assert.deepEqual(buildArgv(twoPos, { first: 'foo' }), ['demo', '--', 'foo']); // trailing absent dropped
  assert.deepEqual(buildArgv(twoPos, { first: 'foo', second: 'bar' }), ['demo', '--', 'foo', 'bar']);
  assert.throws(() => buildArgv(twoPos, { second: 'bar' }), /positional gap/); // non-trailing gap
});

test('buildArgv: spreads an array positional into separate argv tokens', () => {
  const arrayPos = {
    'type': 'object',
    'additionalProperties': false,
    'properties': { sessions: { type: 'array', items: { type: 'string' } } },
    'x-cli': { path: ['session', 'kill'], args: { sessions: { positional: 0 } } },
  };
  // Array positional -> one token per element (not a single comma-joined 'a,b').
  assert.deepEqual(buildArgv(arrayPos, { sessions: ['a', 'b'] }), ['session', 'kill', '--', 'a', 'b']);
});

test('mcpInputSchema: drops an mcpHidden arg from properties + required (toParseArgs keeps it)', () => {
  const hiddenSpec = {
    'type': 'object',
    'required': ['slot', 'watch'],
    'additionalProperties': false,
    'properties': { slot: { type: 'string' }, watch: { type: 'boolean' } },
    'x-cli': {
      path: ['worker', 'ps'],
      args: { slot: { flag: '--slot' }, watch: { flag: '--watch', mcpHidden: true } },
    },
  };
  const schema = mcpInputSchema(hiddenSpec);
  assert.equal(schema.properties.watch, undefined); // hidden from the MCP tool
  assert.equal(schema.properties.slot.type, 'string'); // visible arg stays
  assert.ok(!schema.required.includes('watch')); // and out of required
  assert.deepEqual(schema.required, ['slot']);
  assert.ok('watch' in toParseArgs(hiddenSpec)); // but the CLI parser still gets it
});

const COMMANDS = readdirSync(new URL('../schema/commands', import.meta.url)).filter(file => file.endsWith('.json'));

test('conformance: every spec is well-formed and its MCP-visible args round-trip', () => {
  for (const file of COMMANDS) {
    const spec = loadSchema(`commands/${file}`);
    assert.equal(typeof spec['x-mcp'], 'boolean', `${file}: x-mcp must be boolean`);
    assert.ok(Array.isArray(spec['x-cli'].path), `${file}: x-cli.path must be an array`);
    assert.deepEqual(
      Object.keys(spec.properties ?? {}).sort(),
      Object.keys(spec['x-cli'].args).sort(),
      `${file}: properties vs x-cli.args must be 1:1`,
    );
    // The pipeline only handles arrays as positionals (buildArgv spreads them; a flag would be
    // String()-joined into one comma token). Enforce it so no spec introduces an array FLAG.
    for (const [name, entry] of Object.entries(spec['x-cli'].args)) {
      if (spec.properties?.[name]?.type === 'array')
        assert.ok(entry.positional != null, `${file}: array-typed arg '${name}' must be a positional (array flags are unsupported)`);
    }
    // buildArgv is the MCP path; it rejects mcpHidden args. Sample only the MCP-visible ones,
    // with a value matching each property's declared type so validate() in buildArgv accepts it
    // (an enum needs one of its own values; a number needs an actual number, not the prop name).
    const visible = mcpInputSchema(spec);
    const sample = {};
    for (const [name, prop] of Object.entries(visible.properties ?? {})) {
      if (prop.enum)
        sample[name] = prop.enum[0];
      else if (prop.type === 'boolean')
        sample[name] = true;
      else if (prop.type === 'array')
        sample[name] = [name];
      else if (prop.type === 'number' || prop.type === 'integer')
        sample[name] = 1;
      else sample[name] = name;
    }
    const argv = buildArgv(spec, sample).slice(spec['x-cli'].path.length);
    const { values, positionals } = parseArgs({ args: argv, options: toParseArgs(spec), allowPositionals: true });
    for (const [name, entry] of Object.entries(spec['x-cli'].args)) {
      if (entry.flag && !entry.mcpHidden && name in sample)
        assert.notEqual(values[entry.flag.replace(/^--/, '')], undefined, `${file}: visible flag ${name} round-trips`);
    }
    const visiblePositionals = Object.entries(spec['x-cli'].args).filter(([name, entry]) => entry.positional != null && name in sample).length;
    assert.equal(positionals.length, visiblePositionals, `${file}: positionals round-trip`);
    if (spec['x-mcp'])
      assert.ok(spec.description && spec.description.length > 0, `${file}: x-mcp tool needs a description`);
  }
});

test('conformance: every router command has a spec (and vice versa)', () => {
  const routerCommands = Object.keys(ROUTES).sort();
  const specPaths = COMMANDS.map(file => loadSchema(`commands/${file}`)['x-cli'].path.join(' ')).sort();
  assert.deepEqual(specPaths, routerCommands);
});

test('conformance: worker-run flags are a subset of msg-send (the CLI parses `worker run` with msg-send options)', () => {
  const flagNames = spec => Object.entries(spec['x-cli'].args).filter(([, entry]) => entry.flag).map(([name]) => name);
  const sendFlags = new Set(flagNames(loadSchema('commands/msg-send.json')));
  for (const name of flagNames(loadSchema('commands/worker-run.json'))) {
    // cmdDispatch delegates to cmdMsg(argOptions('msg-send')); a worker-run flag msg-send lacks
    // would fail to parse. worker-run.json exists for the MCP tool + help, so keep it in step.
    assert.ok(sendFlags.has(name), `worker-run flag '${name}' is not in msg-send and would not parse`);
  }
});
