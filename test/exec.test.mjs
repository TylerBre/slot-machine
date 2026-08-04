// Pure-logic tests for exec.mjs helpers (no real processes spawned).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { browserProfilePids, parsePrTsv, prMapChecked, resourceProcessPids } from '../lib/exec.mjs';
import { BROWSER_PROFILE_MARKER } from '../lib/constants.mjs';

const marker = BROWSER_PROFILE_MARKER;

test('browserProfilePids: matches the Chromium bound to the shared profile', () => {
  const ps = `501 /Users/t/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/Users/t/Library/Caches/ms-playwright-mcp/default/.playwright-mcp-profile --remote-debugging-pipe`;
  assert.deepEqual(browserProfilePids(ps, marker), [501]);
});

test('browserProfilePids: spares the node/npm MCP servers that share the profile path', () => {
  const ps = [
    `94837 npm exec @playwright/mcp@latest --user-data-dir=/Users/t/Library/Caches/ms-playwright-mcp/default/.playwright-mcp-profile`,
    `95095 node /Users/t/.npm/_npx/abc/node_modules/.bin/playwright-mcp --user-data-dir=/Users/t/Library/Caches/ms-playwright-mcp/default/.playwright-mcp-profile`,
  ].join('\n');
  assert.deepEqual(browserProfilePids(ps, marker), []); // servers stay up
});

test('browserProfilePids: kills browser + helpers, spares servers, ignores unrelated procs', () => {
  const ps = [
    `1 /sbin/launchd`,
    `94837 npm exec @playwright/mcp@latest --user-data-dir=/x/ms-playwright-mcp/default/.playwright-mcp-profile`,
    `95095 node /x/.bin/playwright-mcp --user-data-dir=/x/ms-playwright-mcp/default/.playwright-mcp-profile`,
    `9001 /x/chrome-mac/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/x/ms-playwright-mcp/default/.playwright-mcp-profile`,
    `9002 /x/Chromium Helper --type=renderer --user-data-dir=/x/ms-playwright-mcp/default/.playwright-mcp-profile`,
    `7777 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, // user's real browser, different profile
  ].join('\n');
  assert.deepEqual(browserProfilePids(ps, marker).sort((left, right) => left - right), [9001, 9002]);
});

test('browserProfilePids: empty / no-match input yields no PIDs', () => {
  assert.deepEqual(browserProfilePids('', marker), []);
  assert.deepEqual(browserProfilePids('1 /sbin/launchd\n2 /usr/sbin/syslogd', marker), []);
});

test('resourceProcessPids: a resource with no registered resolver maps to no processes', () => {
  assert.deepEqual(resourceProcessPids('some-port'), []);
  assert.deepEqual(resourceProcessPids('unknown'), []);
});

test('parsePrTsv: branch -> PRs map; empty and blank-line tolerant', () => {
  const out = 'feat/x\t12\tMERGED\tabc123\nfeat/x\t13\tOPEN\tdef456\n\nmain\t1\tCLOSED\t\n';
  const map = parsePrTsv(out);
  assert.deepEqual(map.get('feat/x'), [
    { number: 12, state: 'MERGED', headOid: 'abc123' },
    { number: 13, state: 'OPEN', headOid: 'def456' },
  ]);
  assert.deepEqual(map.get('main'), [{ number: 1, state: 'CLOSED', headOid: null }]);
  assert.equal(parsePrTsv('').size, 0);
  assert.equal(parsePrTsv(null).size, 0);
});

test('prMapChecked: gh failure is ok:false, genuinely-no-PRs is ok:true + empty map', async (ctx) => {
  if (process.platform === 'win32')
    return ctx.skip('fake-binary PATH shim is POSIX');
  const { mkdtempSync, writeFileSync: wf, chmodSync, rmSync: rm } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sm-fake-gh-'));
  const fake = join(dir, 'gh');
  const realPath = process.env.PATH;
  try {
    // failure: gh exits 1 having printed nothing useful
    wf(fake, '#!/bin/sh\nexit 1\n');
    chmodSync(fake, 0o755);
    process.env.PATH = `${dir}:${realPath}`;
    const failed = await prMapChecked('x/y');
    assert.equal(failed.ok, false);
    assert.equal(failed.map.size, 0);
    // success with zero PRs: exits 0, prints nothing
    wf(fake, '#!/bin/sh\nexit 0\n');
    const empty = await prMapChecked('x/y');
    assert.equal(empty.ok, true);
    assert.equal(empty.map.size, 0);
  }
  finally {
    process.env.PATH = realPath;
    rm(dir, { recursive: true, force: true });
  }
});
