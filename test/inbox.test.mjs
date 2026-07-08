import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendReport, inboxPath, readInbox, shapeInbox } from '../lib/inbox.mjs';

test('inbox: append stamps v + validates; read returns the record', () => {
  const dir = join(tmpdir(), `sm-inbox-${process.pid}-a`);
  process.env.SLOT_INBOX_DIR = dir;
  try {
    appendReport('r', { slot: 'c', message: 'done' });
    const entries = readInbox('r');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].v, 1);
    assert.equal(entries[0].message, 'done');
    assert.throws(() => appendReport('r', { slot: 'c', message: 42 }), /invalid/i);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});

test('shapeInbox: number keeps the most recent N; newestFirst reverses; they compose', () => {
  const entries = [{ message: 'a' }, { message: 'b' }, { message: 'c' }, { message: 'd' }];
  const messages = shaped => shaped.map(entry => entry.message);
  // no options: unchanged (oldest first)
  assert.deepEqual(shapeInbox(entries), entries);
  assert.deepEqual(shapeInbox(entries, {}), entries);
  // most-recent-N = the LAST N of the oldest-first list
  assert.deepEqual(messages(shapeInbox(entries, { number: '2' })), ['c', 'd']);
  // newest-first reverses
  assert.deepEqual(messages(shapeInbox(entries, { newestFirst: true })), ['d', 'c', 'b', 'a']);
  // both compose: last 2, newest first
  assert.deepEqual(messages(shapeInbox(entries, { number: '2', newestFirst: true })), ['d', 'c']);
  // N larger than length = whole list
  assert.deepEqual(messages(shapeInbox(entries, { number: '99' })), ['a', 'b', 'c', 'd']);
  // N = 0 = empty; invalid/non-integer N ignored (show all)
  assert.deepEqual(shapeInbox(entries, { number: '0' }), []);
  assert.deepEqual(messages(shapeInbox(entries, { number: 'abc' })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(messages(shapeInbox(entries, { number: '-1' })), ['a', 'b', 'c', 'd']);
  // does not mutate the input
  assert.deepEqual(messages(entries), ['a', 'b', 'c', 'd']);
});

test('inbox: read elevates a legacy line and skips a malformed one', () => {
  const dir = join(tmpdir(), `sm-inbox-${process.pid}-b`);
  process.env.SLOT_INBOX_DIR = dir;
  try {
    mkdirSync(dir, { recursive: true });
    const legacy = JSON.stringify({ ts: 1, slot: null, message: 'old' }); // no v
    const bad = JSON.stringify({ v: 1, ts: 'nope', message: 'x' }); // ts wrong type
    writeFileSync(inboxPath('r'), `${legacy}\n${bad}\n`);
    const entries = readInbox('r');
    assert.equal(entries.length, 1); // bad skipped
    assert.equal(entries[0].v, 1); // legacy elevated
    assert.equal(entries[0].message, 'old');
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});
