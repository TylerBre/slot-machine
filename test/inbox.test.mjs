import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceCursor,
  appendReport,
  clearInbox,
  deleteCursors,
  inboxCounts,
  inboxPath,
  readCursor,
  readInbox,
  shapeInbox,
} from '../lib/inbox.mjs';

// Each test gets an isolated inbox via SLOT_INBOX_DIR; cursors land in the derived
// sibling `<dir>-state`, so cleanup removes both.
function withInboxDir(suffix, fn) {
  const dir = join(tmpdir(), `sm-inbox-${process.pid}-${suffix}`);
  process.env.SLOT_INBOX_DIR = dir;
  try {
    fn(dir);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-state`, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
}

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

test('cursors: absent reads 0; forward-only advance; corrupt reads 0; unknown kind throws', () => {
  withInboxDir('cur', (dir) => {
    assert.equal(readCursor('r', 'read'), 0);
    assert.equal(advanceCursor('r', 'read', 100), 100);
    assert.equal(readCursor('r', 'read'), 100);
    // backward and equal moves are ignored - a stale caller cannot un-read newer reports
    assert.equal(advanceCursor('r', 'read', 50), 100);
    assert.equal(advanceCursor('r', 'read', 100), 100);
    assert.equal(readCursor('r', 'read'), 100);
    // the two kinds are independent
    assert.equal(readCursor('r', 'surfaced'), 0);
    advanceCursor('r', 'surfaced', 7);
    assert.equal(readCursor('r', 'read'), 100);
    assert.throws(() => readCursor('r', 'bogus'), /unknown cursor kind/);
    // cursor files live in the SIBLING state dir, never the watched inbox dir
    assert.ok(!existsSync(dir) || readdirSync(dir).every(name => !name.endsWith('.json')));
    assert.ok(readdirSync(`${dir}-state`).length >= 2);
    // corrupt cursor fails toward "everything unread"
    writeFileSync(join(`${dir}-state`, 'r.read.json'), 'not json');
    assert.equal(readCursor('r', 'read'), 0);
  });
});

test('clearInbox deletes both cursors; a post-clear report is unread again', () => {
  withInboxDir('clr', () => {
    appendReport('r', { slot: 'a', message: 'one' });
    const seen = appendReport('r', { slot: 'a', message: 'two' });
    advanceCursor('r', 'read', seen.ts);
    advanceCursor('r', 'surfaced', seen.ts);
    assert.equal(inboxCounts('r').unread, 0);
    clearInbox('r');
    assert.equal(readCursor('r', 'read'), 0);
    assert.equal(readCursor('r', 'surfaced'), 0);
    appendReport('r', { slot: 'b', message: 'fresh' });
    const counts = inboxCounts('r');
    assert.deepEqual({ unread: counts.unread, total: counts.total }, { unread: 1, total: 1 });
  });
});

test('inboxCounts: cursor-based unread, raw total, oldest-unread ts; strict boundary', () => {
  withInboxDir('cnt', () => {
    assert.deepEqual(inboxCounts('r'), { unread: 0, total: 0, oldestUnreadTs: null });
    const records = ['a', 'b', 'c'].map(message => appendReport('r', { slot: 's', message }));
    advanceCursor('r', 'read', records[1].ts); // read through 'b'
    const counts = inboxCounts('r');
    assert.equal(counts.total, 3);
    assert.equal(counts.unread, 1); // strictly > cursor: 'b' itself is read
    assert.equal(counts.oldestUnreadTs, records[2].ts);
  });
});

test('deleteCursors: idempotent, removes both kinds', () => {
  withInboxDir('del', () => {
    deleteCursors('r'); // nothing there - no throw
    advanceCursor('r', 'read', 5);
    advanceCursor('r', 'surfaced', 5);
    deleteCursors('r');
    assert.equal(readCursor('r', 'read'), 0);
    assert.equal(readCursor('r', 'surfaced'), 0);
  });
});

test('cmdInbox --unread: displays only unread, advances; repeat shows nothing', async () => {
  const dir = join(tmpdir(), `sm-inbox-${process.pid}-cmd`);
  process.env.SLOT_INBOX_DIR = dir;
  const realLog = console.log;
  const grab = async (argv, cmd) => {
    const out = [];
    console.log = line => out.push(line);
    try {
      await cmd(argv);
    }
    finally {
      console.log = realLog;
    }
    return JSON.parse(out.join('\n'));
  };
  try {
    const { cmdInbox } = await import('../lib/commands/msg.mjs');
    const { REPO_NAME } = await import('../lib/constants.mjs');
    appendReport(REPO_NAME, { slot: 'a', message: 'first' });
    appendReport(REPO_NAME, { slot: 'a', message: 'second' });
    assert.deepEqual((await grab(['--unread', '--json'], cmdInbox)).map(entry => entry.message), ['first', 'second']);
    // a third lands after the read - only it is unread now
    appendReport(REPO_NAME, { slot: 'b', message: 'third' });
    assert.deepEqual((await grab(['--unread', '--json'], cmdInbox)).map(entry => entry.message), ['third']);
    assert.deepEqual(await grab(['--unread', '--json'], cmdInbox), []);
    // default (no --unread) output unchanged: still shows everything, moves no cursor
    assert.equal((await grab(['--json'], cmdInbox)).length, 3);
  }
  finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-state`, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});
