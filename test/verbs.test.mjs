import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerb } from '../lib/slots/verbs.mjs';
import { appendReport, inboxPath } from '../lib/inbox.mjs';

test('parseVerb: every verb, case-insensitive, space tolerated before the colon', () => {
  assert.equal(parseVerb('done: PR #123, 96%'), 'done');
  assert.equal(parseVerb('DONE: shipped'), 'done');
  assert.equal(parseVerb('Blocked : waiting on CI creds'), 'blocked');
  assert.equal(parseVerb('needs-decision: schema A or B?'), 'needs-decision');
  assert.equal(parseVerb('NEEDS-DECISION: pick one'), 'needs-decision');
  assert.equal(parseVerb('failed: suite red after 3 attempts'), 'failed');
  assert.equal(parseVerb('working: tests passing, docs next'), 'working');
  assert.equal(parseVerb('paused: waiting for UAT env'), 'paused');
});

test('parseVerb: total - real-world negatives and junk all parse null', () => {
  // live inbox dialect (verbatim samples from the 145-report backlog)
  assert.equal(parseVerb('#4501 (sc-9824) pushed.'), null);
  assert.equal(parseVerb('ENG-960 #4797 - merge conflict RESOLVED'), null);
  // near-misses: verb must be anchored at the start and followed by a colon
  assert.equal(parseVerb('well done: team'), null);
  assert.equal(parseVerb('doneish: sort of'), null);
  assert.equal(parseVerb('done - PR up'), null);
  // total: any input, no throw
  assert.equal(parseVerb(''), null);
  assert.equal(parseVerb(null), null);
  assert.equal(parseVerb(undefined), null);
  assert.equal(parseVerb(42), null);
});

test('inbox --json carries a computed verb; the stored record never does', async () => {
  const dir = join(tmpdir(), `sm-verbs-${process.pid}`);
  process.env.SLOT_INBOX_DIR = dir;
  const realLog = console.log;
  try {
    const { cmdInbox } = await import('../lib/commands/msg.mjs');
    const { REPO_NAME } = await import('../lib/constants.mjs');
    appendReport(REPO_NAME, { slot: 'a', message: 'done: PR #9' });
    appendReport(REPO_NAME, { slot: 'b', message: 'no verb here' });
    const out = [];
    console.log = line => out.push(line);
    try {
      await cmdInbox(['--json']);
    }
    finally {
      console.log = realLog;
    }
    const shown = JSON.parse(out.join('\n'));
    assert.deepEqual(shown.map(entry => entry.verb), ['done', null]);
    // computed on read, NEVER persisted: the JSONL lines carry no verb key
    const raw = readFileSync(inboxPath(REPO_NAME), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(raw.every(record => !('verb' in record)));
  }
  finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-state`, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});

test('report: null-verb message gets the stderr tip; a verbed one does not', async () => {
  const dir = join(tmpdir(), `sm-verbs-tip-${process.pid}`);
  process.env.SLOT_INBOX_DIR = dir;
  const realLog = console.log;
  const realErr = console.error;
  try {
    const { cmdReport } = await import('../lib/commands/msg.mjs');
    const errs = [];
    console.log = () => {};
    console.error = line => errs.push(line);
    try {
      cmdReport(['done: verbed report']);
      assert.equal(errs.length, 0);
      cmdReport(['plain report, no verb']);
      assert.equal(errs.length, 1);
      assert.match(errs[0], /tip: prefix with done:/);
    }
    finally {
      console.log = realLog;
      console.error = realErr;
    }
  }
  finally {
    console.log = realLog;
    console.error = realErr;
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-state`, { recursive: true, force: true });
    delete process.env.SLOT_INBOX_DIR;
  }
});

test('--brief preamble carries the verb instruction to the worker', async () => {
  const { briefText } = await import('../lib/commands/msg.mjs');
  const text = briefText('c', 'fix the flaky test');
  assert.match(text, /slot c/);
  assert.match(text, /done:\/blocked:\/needs-decision:\/failed:\/working:\/paused:/);
  assert.match(text, /fix the flaky test$/);
});
