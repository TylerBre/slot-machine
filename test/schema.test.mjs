// test/schema.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, validate } from '../lib/schema.mjs';

const OBJ = {
  type: 'object',
  required: ['v', 'name'],
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    name: { type: 'string' },
    tag: { type: ['string', 'null'] },
    kind: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

test('validate: accepts a conforming object', () => {
  assert.deepEqual(validate({ v: 1, name: 'x', tag: null, kind: 'a', tags: ['y'] }, OBJ), []);
});

test('validate: flags missing required, wrong type, bad const/enum, unexpected key, bad item', () => {
  assert.ok(validate({ name: 'x' }, OBJ).some(problem => problem.includes('required \'v\'')));
  assert.ok(validate({ v: 1, name: 2 }, OBJ).some(problem => problem.includes('\'name\'')));
  assert.ok(validate({ v: 2, name: 'x' }, OBJ).some(problem => problem.includes('must equal')));
  assert.ok(validate({ v: 1, name: 'x', kind: 'z' }, OBJ).some(problem => problem.includes('one of')));
  assert.ok(validate({ v: 1, name: 'x', bogus: 1 }, OBJ).some(problem => problem.includes('unexpected')));
  assert.ok(validate({ v: 1, name: 'x', tags: [3] }, OBJ).some(problem => problem.includes('tags[0]')));
  assert.deepEqual(validate(null, OBJ), ['not an object']);
});

test('validate: nested missing-required and unexpected keys carry the path', () => {
  const schema = {
    type: 'object',
    properties: {
      inner: { type: 'object', required: ['x'], additionalProperties: false, properties: { x: { type: 'string' } } },
    },
  };
  assert.ok(validate({ inner: {} }, schema).some(problem => problem.includes('inner: missing')));
  assert.ok(validate({ inner: { x: 'a', y: 1 } }, schema).some(problem => problem.includes('inner: unexpected')));
});

test('validate: additionalProperties as a subschema validates map values', () => {
  const map = { type: 'object', additionalProperties: { type: 'object', required: ['n'], properties: { n: { type: 'string' } } } };
  assert.deepEqual(validate({ a: { n: 'x' } }, map), []);
  assert.ok(validate({ a: { n: 5 } }, map).some(problem => problem.includes('a.n')));
});

test('validate: a top-level array is not a valid object', () => {
  assert.deepEqual(validate([1, 2, 3], { required: ['x'] }), ['not an object']);
});

test('loadSchema: loads a schema and resolves $ref to a sibling file', () => {
  const worktree = loadSchema('worktree-lock.schema.json');
  assert.equal(worktree.properties.v.const, 1);
  // resources[].items is a $ref to resource-lock.schema.json, resolved inline
  assert.equal(worktree.properties.resources.items.title, 'resource-lock');
  assert.equal(worktree.properties.resources.items.properties.resource.type, 'string');
});
