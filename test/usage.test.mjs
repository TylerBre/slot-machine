import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsage, recordUsage } from '../lib/usage.mjs';

test('usage: record stamps v; read returns it', () => {
  const file = join(tmpdir(), `sm-usage-${process.pid}-a.jsonl`);
  process.env.SLOT_USAGE_FILE = file;
  try {
    recordUsage({ cmd: 'slot ls', ok: true, ms: 5, repo: 'x', tty: false });
    const entries = readUsage();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].v, 1);
    assert.equal(entries[0].cmd, 'slot ls');
  }
  finally {
    rmSync(file, { force: true });
    delete process.env.SLOT_USAGE_FILE;
  }
});

test('usage: read elevates a legacy line and skips an invalid one, never throwing', () => {
  const file = join(tmpdir(), `sm-usage-${process.pid}-b.jsonl`);
  process.env.SLOT_USAGE_FILE = file;
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ts: 1, cmd: 'slot ls' })}\n${JSON.stringify({ v: 1, ts: 2 })}\n`);
    const entries = readUsage(); // legacy elevated, second (missing cmd) skipped
    assert.equal(entries.length, 1);
    assert.equal(entries[0].v, 1);
    assert.equal(entries[0].cmd, 'slot ls');
  }
  finally {
    rmSync(file, { force: true });
    delete process.env.SLOT_USAGE_FILE;
  }
});
