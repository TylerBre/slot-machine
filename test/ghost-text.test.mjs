// test/ghost-text.test.mjs - the ANSI faint-span stripper behind the composer-cleared check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripGhostText } from '../lib/exec.mjs';

const ESC = '\x1B';

test('stripGhostText: plain text passes through unchanged', () => {
  assert.equal(stripGhostText('❯ hello world'), '❯ hello world');
  assert.equal(stripGhostText(''), '');
  assert.equal(stripGhostText(null), '');
});

test('stripGhostText: faint span dropped, normal text kept', () => {
  // A Claude composer line: real prompt, then a dim autocomplete suggestion.
  const line = `❯ ${ESC}[2mtry "sm floor"${ESC}[22m`;
  assert.equal(stripGhostText(line), '❯ ');
});

test('stripGhostText: full reset also ends a faint span', () => {
  assert.equal(stripGhostText(`a${ESC}[2mghost${ESC}[0mb`), 'ab');
  assert.equal(stripGhostText(`a${ESC}[2mghost${ESC}[mb`), 'ab'); // empty params = reset
});

test('stripGhostText: color sequences are stripped but their text is kept', () => {
  assert.equal(stripGhostText(`${ESC}[32mgreen${ESC}[0m and ${ESC}[1mbold${ESC}[22m`), 'green and bold');
});

test('stripGhostText: combined params (2;3m) start a faint span', () => {
  assert.equal(stripGhostText(`x${ESC}[2;3mdim italic${ESC}[0my`), 'xy');
});

test('stripGhostText: unterminated faint runs to end of text', () => {
  assert.equal(stripGhostText(`real${ESC}[2mghost to eol`), 'real');
});

test('stripGhostText: non-SGR CSI sequences are dropped without eating text', () => {
  assert.equal(stripGhostText(`a${ESC}[2Kb${ESC}[1;5Hc`), 'abc');
});
