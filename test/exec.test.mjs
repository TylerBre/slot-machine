// Pure-logic tests for exec.mjs helpers (no real processes spawned).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { browserProfilePids, resourceProcessPids } from '../lib/exec.mjs';
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
