// Router + shim mapping invariants. Run: node --test  (or npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { helpKey, NAMESPACES, ROUTES } from '../lib/router.mjs';
import { HELP, helpFor, ROLE_DISPATCHER, ROLE_WORKER, SECTIONS, USAGE, VOCAB } from '../lib/help.mjs';

test('every route has a handler function', () => {
  for (const [route, fn] of Object.entries(ROUTES)) {
    assert.equal(typeof fn, 'function', `ROUTES['${route}'] is not a function`);
  }
});

test('every route has detailed help', () => {
  for (const route of Object.keys(ROUTES)) {
    assert.ok(HELP[route], `no HELP entry for route '${route}'`);
    assert.ok(
      HELP[route].startsWith(`sm ${route}`),
      `HELP['${route}'] usage line does not start with 'sm ${route}'`,
    );
  }
});

test('every namespace has a section, composed into USAGE', () => {
  for (const ns of NAMESPACES) {
    assert.ok(SECTIONS[ns], `no SECTIONS entry for namespace '${ns}'`);
    assert.ok(USAGE.includes(SECTIONS[ns]), `USAGE does not include the '${ns}' section`);
  }
});

test('help text does not teach retired flat spellings (the unambiguous ones)', () => {
  // Only spellings that cannot appear inside a valid new route are checkable this way:
  // e.g. 'slot create' is a substring of the canonical 'sm slot create', so old spellings
  // sharing the slot namespace are excluded. Deliberate legacy notes that quote
  // 'slot free' etc. are allowed (lookbehind).
  const taught = /(?<!')\bslot (free|info|dispatch|unlock|locks|peek)\b/;
  for (const [key, text] of Object.entries({ ...HELP, USAGE })) {
    assert.ok(!taught.test(text), `HELP['${key}'] still teaches an old spelling`);
  }
});

test('helpKey resolves routes, namespaces, and verb aliases', () => {
  assert.equal(helpKey([]), '');
  assert.equal(helpKey(['slot', 'ls']), 'slot ls');
  assert.equal(helpKey(['slot']), 'slot');
  assert.equal(helpKey(['msg', 'ls']), 'msg inbox');
  assert.equal(helpKey(['session', 'list']), 'session ls');
});

test('helpFor returns real text for every route, namespace, the vocab, and the overview', () => {
  assert.equal(helpFor(''), USAGE);
  assert.equal(helpFor('vocab'), VOCAB);
  for (const ns of NAMESPACES) assert.ok(helpFor(ns).includes(SECTIONS[ns]));
  for (const route of Object.keys(ROUTES))
    assert.ok(!helpFor(route).includes('no help for'), `helpFor('${route}') fell through`);
});

test('teaching text never uses the dead vocabulary (tenant/scratch/orchestrator)', () => {
  const dead = /\b(tenant|scratch|orchestrator)s?\b/i;
  const teaching = { USAGE, VOCAB, ROLE_DISPATCHER, ROLE_WORKER, ...SECTIONS, ...HELP };
  for (const [key, text] of Object.entries(teaching)) {
    const match = text.match(dead);
    assert.ok(!match, `'${key}' still says '${match?.[0]}'`);
  }
});
