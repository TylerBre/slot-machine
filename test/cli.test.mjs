// End-to-end CLI tests through the real binaries, hermetic via a throwaway $HOME (config,
// inbox, locks, and usage all live under it) and a scratch git repo with a local bare origin
// (so origin/<base> resolves - freeness/reset measure commits-ahead against it). No tmux
// session is created and no worker is spawned; tmux-dependent state simply reads as 'none'.
// Tests run in file order and share the fixture.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SM = fileURLToPath(new URL('../bin/sm', import.meta.url));

const FAKE = realpathSync(mkdtempSync(join(tmpdir(), 'sm-cli-'))); // realpath: macOS tmpdir is a /private symlink
const repoDir = join(FAKE, 'code', 'myapp');
mkdirSync(repoDir, { recursive: true });
const git = (...args) => spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
// A local bare origin so origin/main resolves: freeness (commits-ahead) and reset measure against
// it. Without one, slotGit cannot count ahead and every slot correctly reads 'unknown' (fail-safe).
const originDir = join(FAKE, 'code', 'myapp-origin.git');
spawnSync('git', ['init', '-q', '--bare', '-b', 'main', originDir], { encoding: 'utf8' });
git('remote', 'add', 'origin', originDir);
git('push', '-q', 'origin', 'main');
git('fetch', '-q', 'origin'); // ensure refs/remotes/origin/main exists for rev-list

// TMUX_TMPDIR points at an empty dir (and TMUX is dropped) so children never see the
// machine's real tmux server - worker 'none' is guaranteed, not a coincidence.
// SLOT_NO_RESOURCE_KILL: the release-browser test exercises the release path through the real
// binary; without this seam resourceProcessPids('browser') would scan + SIGTERM real host
// Chromium (e.g. a running Playwright-MCP browser). It keeps the test hermetic.
const env = {
  ...process.env,
  HOME: FAKE,
  NO_COLOR: '1',
  TMUX_TMPDIR: join(FAKE, 'no-tmux'),
  SLOT_NO_RESOURCE_KILL: '1',
};
delete env.TMUX;
mkdirSync(env.TMUX_TMPDIR, { recursive: true });
function runBin(bin, args, opts = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env, ...opts });
}
const sm = (...args) => runBin(SM, args);
const json = result => JSON.parse(result.stdout);

after(() => rmSync(FAKE, { recursive: true, force: true }));

test('cli: unconfigured commands point at sm use; unknown commands hint', () => {
  assert.equal(sm('slot', 'ls').status, 1);
  assert.match(sm('slot', 'ls').stderr, /no current repo - run: sm repo use <repo>/);
  assert.match(sm().stderr, /no current repo/); // bare sm = session attach; unconfigured it teaches sm use
  assert.match(sm('bogus').stderr, /unknown command 'bogus'.*sm --help/);
  assert.match(sm('slot', 'bogus').stderr, /unknown command 'slot bogus'.*sm help slot/);
  assert.equal(sm('slot', 'bogus').status, 1);
});

test('cli: help surfaces work without a repo', () => {
  const overview = sm('--help');
  assert.equal(overview.status, 0);
  assert.match(overview.stdout, /sm - slot machine/);
  for (const ns of ['session -', 'slot -', 'worker -', 'msg -', 'lock -']) {
    assert.ok(overview.stdout.includes(ns), `overview missing '${ns}' section`);
  }
  assert.match(sm('help', 'vocab').stdout, /dispatcher\s+the role at the desk/);
  assert.match(sm('help', 'slot', 'ls').stdout, /^sm slot ls/);
  assert.match(sm('slot', 'ls', '--help').stdout, /^sm slot ls/);
  assert.match(sm('slot').stdout, /slot - the worktree inventory/); // bare namespace
});

test('cli: repo use derives and persists; ls/inspect/rm manage the config', () => {
  const result = sm('repo', 'use', repoDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /using myapp/);
  assert.match(result.stdout, /prefix myapp-slot-/);
  const status = json(sm('repo', 'ls', '--json'));
  assert.equal(status.current, repoDir);
  assert.ok(status.repos[repoDir]);
  assert.equal(sm('repo', 'use', join(FAKE, 'nowhere')).status, 1); // not a git repo
  assert.match(sm('repo', 'use').stderr, /use: name a repo/); // REPO is required now

  const inspected = json(sm('repo', 'inspect', '--json'));
  assert.equal(inspected.repoDir, repoDir);
  assert.equal(inspected.current, true);
  assert.equal(inspected.prefix, 'myapp-slot-');

  // rm forgets (by name), clears current; re-use restores for the rest of the suite
  const rm = json(sm('repo', 'rm', 'myapp', '--json'));
  assert.equal(rm.removed, true);
  assert.equal(rm.currentCleared, true);
  assert.match(sm('slot', 'ls').stderr, /no current repo/);
  assert.equal(sm('repo', 'use', repoDir).status, 0);
});

test('cli: a corrupt config fails loud, not silently', () => {
  const configPath = join(FAKE, '.config', 'slot', 'config.json');
  const saved = readFileSync(configPath, 'utf8'); // suite has a valid config by now
  try {
    writeFileSync(configPath, '{"v":1,"current":123,"repos":{}}'); // current must be string|null
    const result = sm('slot', 'ls');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config at .* is invalid/);
  }
  finally {
    writeFileSync(configPath, saved); // restore for later tests
  }
});

test('cli: an unparseable config fails loud, not silently', () => {
  const configPath = join(FAKE, '.config', 'slot', 'config.json');
  const saved = readFileSync(configPath, 'utf8');
  try {
    writeFileSync(configPath, '{ not valid json');
    const result = sm('slot', 'ls');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config at .* is not valid JSON/);
  }
  finally {
    writeFileSync(configPath, saved);
  }
});

test('cli: doctor survives an invalid config and reports it as a failed check', () => {
  const configPath = join(FAKE, '.config', 'slot', 'config.json');
  const saved = readFileSync(configPath, 'utf8'); // suite has a valid config by now
  try {
    writeFileSync(configPath, '{"v":1,"current":123,"repos":{}}'); // schema-invalid
    const result = sm('doctor', '--json');
    const rep = json(result); // doctor still emitted its report - it did not die at import/load
    const names = rep.checks.map(check => check.name);
    assert.ok(names.includes('node'), 'doctor did not run its other checks'); // machinery ran
    const configCheck = rep.checks.find(check => check.name === 'config');
    assert.ok(configCheck, 'doctor missing the config health check');
    assert.equal(configCheck.level, 'fail'); // the bad config is a failed check, not a silent pass
    assert.match(configCheck.detail, /config at .* is invalid/);
    assert.equal(rep.ok, false);
  }
  finally {
    writeFileSync(configPath, saved); // restore for later tests
  }
});

test('cli: help survives an invalid config (the escape hatch)', () => {
  const configPath = join(FAKE, '.config', 'slot', 'config.json');
  const saved = readFileSync(configPath, 'utf8');
  try {
    writeFileSync(configPath, '{ not valid json');
    const result = sm('help');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /sm - slot machine/);
  }
  finally {
    writeFileSync(configPath, saved);
  }
});

test('cli: a non-object config fails loud (M2)', () => {
  const configPath = join(FAKE, '.config', 'slot', 'config.json');
  const saved = readFileSync(configPath, 'utf8');
  try {
    writeFileSync(configPath, '[1,2,3]'); // valid JSON, but not an object
    const result = sm('slot', 'ls');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config at .* is invalid/);
  }
  finally {
    writeFileSync(configPath, saved);
  }
});

test('cli: slot create makes a worktree and reports the real start point', () => {
  const created = json(sm('slot', 'create', 'a', '--json'));
  assert.equal(created.slot, 'a');
  assert.equal(created.branch, 'myapp-slot-a');
  assert.equal(created.from, 'origin/main'); // forks from the origin base branch
  assert.ok(existsSync(join(FAKE, 'code', 'myapp-slot-a', '.git')));
  assert.match(sm('slot', 'create', 'a').stderr, /already exists/);
  assert.equal(json(sm('slot', 'create', 'b', '--json')).slot, 'b');
});

test('cli: slot ls classifies fresh slots as free (worker none)', () => {
  const rows = json(sm('slot', 'ls', '--json'));
  assert.deepEqual(
    rows.map(row => row.slot),
    ['a', 'b'],
  );
  for (const row of rows) {
    assert.equal(row.free, true);
    assert.equal(row.status, 'free');
    assert.equal(row.worker, 'none'); // no pane anywhere
    assert.equal(row.branch, `myapp-slot-${row.slot}`);
  }
});

test('cli: slot lock claim marks busy; no live worker means stale; release frees', () => {
  assert.equal(sm('lock', 'claim', 'a', 'ABC-1').status, 0);
  const row = json(sm('slot', 'ls', '--json')).find(entry => entry.slot === 'a');
  assert.equal(row.free, false);
  assert.equal(row.status, 'stale'); // locked, but no live worker holds it
  const inspected = json(sm('slot', 'inspect', 'a', '--json'));
  assert.equal(inspected.lock.live, false); // dead-owner lock must not report LIVE
  assert.equal(inspected.lock.task, 'ABC-1'); // the lock's task is part of the record
  const rel = json(sm('lock', 'release', 'a', '--json'));
  assert.equal(rel.released, true);
  assert.equal(json(sm('slot', 'ls', '--json')).find(entry => entry.slot === 'a').status, 'free');
});

test('cli: resource locks are exclusive with holder info', () => {
  // one lockfile: a resource claim is embedded in a slot's worktree lock, so the slot must be locked
  sm('lock', 'claim', 'a', 'holds-browser');
  assert.equal(json(sm('lock', 'claim', 'browser', 'shot', '-s', 'a', '--json')).claimed, true);
  const lose = sm('lock', 'claim', 'browser', '-s', 'b', '--json'); // held by slot a; b cannot take it
  assert.equal(lose.status, 1);
  const loseJson = json(lose);
  assert.equal(loseJson.claimed, false);
  assert.equal(loseJson.holder.slot, 'a'); // loser sees which slot holds it
  const held = json(sm('lock', 'ls', '--json'));
  assert.equal(held.length, 1);
  assert.equal(held[0].resource, 'browser');
  assert.equal(held[0].slot, 'a');
  assert.equal(json(sm('lock', 'release', 'browser', '--json')).released, true);
  sm('lock', 'release', 'a'); // free slot a's lock for later tests
});

test('cli: worker ps shows every slot cheaply, with the task its lock carries', () => {
  sm('lock', 'claim', 'b', 'ps-task');
  const rows = json(sm('worker', 'ps', '--json'));
  assert.deepEqual(
    rows.map(row => row.slot),
    ['a', 'b'],
  );
  for (const row of rows) {
    assert.equal(row.worker, 'none'); // hermetic: no pane anywhere
    assert.equal(row.activity, '-');
  }
  assert.equal(rows.find(row => row.slot === 'b').task, 'ps-task');
  assert.equal(rows.find(row => row.slot === 'a').task, null);
  sm('lock', 'release', 'b');
});

test('cli: session attach/detach/reload and slot focus fail cleanly without tmux', () => {
  assert.match(sm('session', 'attach').stderr, /attach: no running myapp\* session/);
  assert.match(sm().stderr, /attach: no running myapp\* session/); // bare sm = attach
  assert.match(sm('session', 'detach').stderr, /detach: no running myapp\* tmux session/);
  assert.match(sm('session', 'reload').stderr, /reload: no running myapp\* tmux session/);
  assert.match(sm('slot', 'focus', 'a').stderr, /focus: no pane for slot a/);
  for (const bad of [sm('session', 'attach'), sm('slot', 'focus', 'a')]) assert.equal(bad.status, 1);
});

test('cli: worker logs and kill fail cleanly without a pane', () => {
  assert.match(sm('worker', 'logs', 'nope').stderr, /no worktree/);
  const logs = json(sm('worker', 'logs', 'a', '--json'));
  assert.equal(logs.activity, 'no-pane');
  assert.deepEqual(logs.tail, []);
  assert.equal(logs.pane, null);
  assert.match(sm('worker', 'kill', 'a').stderr, /no pane for slot a/);
  assert.equal(sm('worker', 'kill', 'a').status, 1);
});

test('cli: preflight judges cwd - slot ok, main checkout stops, elsewhere warns', () => {
  const at = cwd => json(runBin(SM, ['worker', 'preflight', '--json'], { cwd }));
  assert.deepEqual(at(join(FAKE, 'code', 'myapp-slot-a')), {
    ok: true,
    status: 'slot',
    slot: 'a',
    cwd: join(FAKE, 'code', 'myapp-slot-a'),
  });
  assert.equal(at(repoDir).status, 'main-checkout');
  assert.equal(at(FAKE).status, 'outside');
  assert.equal(runBin(SM, ['worker', 'preflight'], { cwd: repoDir }).status, 1);
});

test('cli: worker role auto-detects from cwd and can be forced', () => {
  const inSlot = json(runBin(SM, ['worker', 'role', '--json'], { cwd: join(FAKE, 'code', 'myapp-slot-a') }));
  assert.equal(inSlot.role, 'worker');
  assert.equal(inSlot.slot, 'a');
  assert.equal(json(runBin(SM, ['worker', 'role', '--json'], { cwd: repoDir })).role, 'dispatcher');
  const forced = json(runBin(SM, ['worker', 'role', 'worker', '--json'], { cwd: repoDir }));
  assert.equal(forced.role, 'worker'); // forced beats cwd detection
});

test('cli: report -> inbox round-trip through the binary', () => {
  assert.equal(sm('msg', 'report', 'done: PR #1, 96%', '-s', 'a').status, 0);
  const got = json(sm('msg', 'inbox', '--json'));
  assert.equal(got.length, 1);
  assert.equal(got[0].slot, 'a');
  assert.equal(got[0].message, 'done: PR #1, 96%');
  sm('msg', 'inbox', '--clear');
  assert.deepEqual(json(sm('msg', 'inbox', '--json')), []);
});

test('cli: stats records canonical route spellings', () => {
  const cmds = json(sm('stats', '--json')).map(row => row.cmd);
  assert.ok(cmds.includes('slot ls'), `expected 'slot ls' in ${cmds}`);
  assert.ok(cmds.includes('slot create'), `expected 'slot create' in ${cmds}`);
});

test('cli: reset returns a slot to a clean base and releases its lock', () => {
  sm('lock', 'claim', 'a', 'stale-task');
  const result = sm('slot', 'reset', 'a', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result).reset, true);
  assert.equal(existsSync(join(FAKE, 'code', 'myapp-slot-a', '.worktree-lock')), false);
  assert.equal(json(sm('slot', 'ls', '--json')).find(row => row.slot === 'a').status, 'free');
});

test('cli: a slot with unmerged commits is wip, and reset refuses to discard them without --force', () => {
  assert.equal(json(sm('slot', 'create', 'c', '--json')).slot, 'c');
  const slotC = join(FAKE, 'code', 'myapp-slot-c');
  // commit in the slot so it is ahead of origin/main (unmerged, unpushed work)
  spawnSync('git', ['-C', slotC, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'wip'], { encoding: 'utf8' });
  assert.equal(json(sm('slot', 'ls', '--json')).find(row => row.slot === 'c').status, 'wip');
  // reset must NOT silently discard the commit
  const refused = sm('slot', 'reset', 'c');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /commit\(s\) not on origin\/main .*--force/);
  // --force reclaims it back to a clean base
  const forced = sm('slot', 'reset', 'c', '--force', '--json');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(json(forced).reset, true);
  assert.equal(json(sm('slot', 'ls', '--json')).find(row => row.slot === 'c').status, 'free');
  sm('slot', 'rm', 'c', '--force'); // cleanup: leave the shared fixture at a, b
});

test('cli: slot rm removes the worktree', () => {
  const result = json(sm('slot', 'rm', 'b', '--json'));
  assert.equal(result.removed, true);
  assert.equal(existsSync(join(FAKE, 'code', 'myapp-slot-b')), false);
  assert.match(sm('slot', 'rm', 'b').stderr, /no worktree/);
});

test(
  'cli: doctor reports repo health and exits 0 on a sane setup',
  { skip: spawnSync('tmux', ['-V']).status !== 0 ? 'doctor ok requires tmux installed' : false },
  () => {
    const result = sm('doctor', '--json');
    const rep = json(result);
    assert.equal(rep.ok, true, JSON.stringify(rep.checks));
    const names = rep.checks.map(check => check.name);
    for (const name of ['tmux', 'git', 'node', 'agent claude', 'repo', 'slots', 'bin links', '  mcp (claude)']) {
      assert.ok(names.includes(name), `doctor missing check '${name}'`);
    }
  },
);
