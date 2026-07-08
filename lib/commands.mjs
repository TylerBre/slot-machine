// Subcommand implementations.
import { parseArgs } from 'node:util';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import {
  HOME,
  docs,
  PREFIX,
  SESSION_PREFIX,
  BASE_BRANCH,
  ROLE_DISPATCHER,
  ROLE_WORKER,
  configReport,
  REPO_DIR,
  REPO_NAME,
} from './constants.mjs';
import { loadConfig, saveConfig, mainWorktree, defaultBranch, deriveContext } from './context.mjs';
import {
  die,
  emitJson,
  clr,
  startSpinner,
  fmtAge,
  agoStr,
  pad,
  oneLine,
  formatSessions,
  renderFree,
} from './format.mjs';
import {
  tmux,
  tmuxOut,
  hasSession,
  req,
  sendLine,
  attachOrSwitch,
  run,
  pexec,
  repoSlug,
  slotGit,
  listSlots,
} from './exec.mjs';
import {
  resolveSlots,
  selectPanes,
  pickDispatchSlot,
  paneActivity,
  detectRole,
  preflightStatus,
  readLock,
  lockTranscriptAge,
  slotWorkerMap,
  slotPanes,
  slotRef,
  lockIsLive,
  slotSessions,
  sessionRows,
  slotFreenessRows,
  writeLock,
  removeLock,
} from './slots.mjs';
import { appendReport, readInbox, clearInbox, waitForReports } from './inbox.mjs';
import { readUsage, clearUsage, summarizeUsage } from './usage.mjs';
import { claimResource, releaseResource, listResourceLocks } from './locks.mjs';
import { writeTmuxBlock, tmuxTitlesStatus, TMUX_SETTINGS } from './tmuxconf.mjs';
import { linkStatus, fixLink, binDirOnPath, BINS, BIN_DIR, PKG_ROOT } from './setup.mjs';

// Shared parseArgs wrapper: every command gets --json/--help for free and dies in one
// voice on unknown flags. Handlers never see --help (the router prints route help first).
function parseCmd(who, argv, options = {}) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        ...options,
      },
    });
  } catch (e) {
    die(`${who}: ${e.message} (try --help)`);
  }
}

// The Claude Code project dir for a worktree - one slugging rule, used by both the
// resume check and last-message reading so they can never disagree.
const projectDir = (dir) => join(HOME, '.claude', 'projects', dir.replace(/[/.]/g, '-'));

// slotFreenessRows behind a spinner (skipped when quiet/--json).
async function freenessRows(quiet, text = 'checking slots (git fetch + gh pr)...') {
  const stop = quiet ? () => {} : startSpinner(text);
  try {
    return await slotFreenessRows();
  } finally {
    stop();
  }
}

// Shared watch loop: snapshot first (possibly slow), then clear + render - no blank flash.
async function watchLoop(header, ms, snap, render) {
  for (;;) {
    const shot = await snap();
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(clr.dim(`${header}  (watch: refresh ${ms / 1000}s, Ctrl-C to stop)\n`));
    render(shot);
    await new Promise((r) => setTimeout(r, ms));
  }
}

// role: print the desk->slots operating model. Auto-detects dispatcher vs worker from
// the current dir; pass 'dispatcher' or 'worker' to force one.
export function cmdRole(argv) {
  const { values, positionals } = parseCmd('role', argv);
  const forced = positionals[0];
  const det = detectRole(process.cwd(), docs, PREFIX);
  const role = forced === 'worker' || forced === 'dispatcher' ? forced : det.role;
  const text = role === 'worker' ? ROLE_WORKER : ROLE_DISPATCHER;
  if (values.json) {
    emitJson({ role, slot: det.slot, text });
    return;
  }
  if (role === 'worker' && det.slot) console.log(clr.bold(`slot ${det.slot}\n`));
  console.log(text);
}

// preflight: a slot worker runs this before any git work to confirm cwd is its own slot worktree,
// not the main checkout. Exit 0 in a slot, non-zero otherwise, so it can gate a chain:
//   sm worker preflight && git switch -c my-branch
// Guards the class of bug where a worker branches/commits in the main repo instead of its slot.
export function cmdPreflight(argv) {
  const { values } = parseCmd('preflight', argv);
  const cwd = process.cwd();
  const { ok, status, slot } = preflightStatus(cwd, { root: docs, prefix: PREFIX, repoDir: REPO_DIR });
  if (values.json) {
    emitJson({ ok, status, slot, cwd });
    if (!ok) process.exit(1);
    return;
  }
  if (status === 'slot')
    console.log(clr.green(`OK - in slot ${clr.bold(slot)} (${PREFIX}${slot}). Safe to work here.`));
  else if (status === 'main-checkout')
    console.log(
      clr.red(`STOP - you are in the MAIN checkout (${REPO_DIR}), not a slot worktree.`) +
        `\nNever branch, commit, or push here. cd to your slot (${PREFIX}<label>), then re-run 'sm worker preflight' before any git work.`,
    );
  else
    console.log(
      clr.yellow(`WARNING - cwd is not a slot worktree under ${docs}/${PREFIX}*.`) +
        `\ncd to your slot before working so your branch and commits land in the right place.`,
    );
  if (!ok) process.exit(1);
}

// report "<message>": a slot worker's back-channel to the dispatcher. Detects its own slot from
// cwd and appends the message to the repo inbox, which the dispatcher reads via `sm msg inbox`.
export function cmdReport(argv) {
  const { values, positionals } = parseCmd('report', argv, {
    slot: { type: 'string', short: 's' },
  });
  if (!positionals.length) die('report: a message is required, e.g. sm msg report "done: PR #123, 96%"');
  if (positionals.length > 1)
    die(`report: unexpected extra argument '${positionals[1]}' - quote the message`);
  const slot = values.slot || detectRole(process.cwd(), docs, PREFIX).slot || null;
  appendReport(REPO_NAME, { slot, message: positionals[0] });
  if (values.json) {
    emitJson({ reported: true, slot, repo: REPO_NAME });
    return;
  }
  console.log(`reported to dispatcher${slot ? ` as slot ${slot}` : ''}`);
}

// inbox: the dispatcher reads worker reports. --clear consumes them; --watch tails and exits on
// the first new report (for background re-invoke); --json for machine output.
export async function cmdInbox(argv) {
  const { values } = parseCmd('inbox', argv, {
    clear: { type: 'boolean' },
    watch: { type: 'boolean' },
  });
  if (values.watch) {
    // Subscribe, don't poll: fs events wake us the moment a report lands (see waitForReports).
    const fresh = await waitForReports(REPO_NAME);
    if (fresh.length) {
      printInbox(fresh, values.json);
      if (values.clear) clearInbox(REPO_NAME);
      return;
    }
    if (values.json) emitJson([]);
    else console.log('inbox: no new reports (watch timed out)');
    return;
  }
  printInbox(readInbox(REPO_NAME), values.json);
  if (values.clear) clearInbox(REPO_NAME);
}

// stats: per-command usage from the local usage log - what gets used, what fails, what's slow.
export function cmdStats(argv) {
  const { values } = parseCmd('stats', argv, {
    days: { type: 'string', short: 'd' },
    clear: { type: 'boolean' },
  });
  let entries = readUsage();
  const total = entries.length;
  if (values.days) {
    const cutoff = Date.now() - (parseInt(values.days, 10) || 0) * 86_400_000;
    entries = entries.filter((e) => (e.ts || 0) >= cutoff);
  }
  const rows = summarizeUsage(entries);
  if (values.json) {
    emitJson(rows);
  } else if (!rows.length) {
    console.log('stats: no usage recorded yet');
  } else {
    const w = Math.max(8, ...rows.map((r) => r.cmd.length));
    console.log(
      clr.dim(
        `${'command'.padEnd(w)}  ${'count'.padStart(5)}  ${'errs'.padStart(4)}  ${'tty'.padStart(4)}  ${'avg ms'.padStart(7)}  ${'max ms'.padStart(7)}  last used`,
      ),
    );
    for (const r of rows) {
      const last = r.lastTs ? agoStr(r.lastTs) : '-';
      const errs = r.errors ? clr.red(String(r.errors).padStart(4)) : '   0';
      console.log(
        `${clr.bold(r.cmd.padEnd(w))}  ${String(r.count).padStart(5)}  ${errs}  ${String(r.tty).padStart(4)}  ${String(r.avgMs).padStart(7)}  ${String(r.maxMs).padStart(7)}  ${clr.dim(last)}`,
      );
    }
    console.log(
      clr.dim(
        `\n${entries.length} invocation(s)${values.days ? ` in the last ${values.days}d (of ${total} total)` : ''}`,
      ),
    );
  }
  if (values.clear) clearUsage();
}

function printInbox(entries, json) {
  if (json) {
    emitJson(entries);
    return;
  }
  if (!entries.length) {
    console.log('inbox: empty');
    return;
  }
  for (const e of entries) {
    const age = e.ts ? agoStr(e.ts) : '';
    console.log(`${clr.bold(e.slot || '-')}  ${clr.dim(age)}  ${e.message}`);
  }
}

// Last assistant text from a slot's newest Claude transcript (null if none).
function lastAssistant(dir) {
  const projDir = projectDir(dir);
  let files;
  try {
    files = readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const newest = files.map((f) => [f, statSync(join(projDir, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0];
  let text = null;
  try {
    for (const line of readFileSync(join(projDir, newest), 'utf8').split('\n')) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === 'assistant')
        for (const b of o.message?.content || []) {
          if (b && b.type === 'text' && b.text && b.text.trim()) text = b.text.trim();
        }
    }
  } catch {
    return null;
  }
  return text;
}

// Resolve the target session: explicit -t wins; else the sole running acme* session.
function resolveSession(explicit, who) {
  let sess = explicit;
  if (!sess) {
    const rows = sessionRows();
    if (rows.length === 1) sess = rows[0].name;
    else if (rows.length === 0) die(`${who}: no running ${SESSION_PREFIX}* tmux session; pass one with -t`);
    else {
      console.error(`${who}: several ${SESSION_PREFIX}* sessions are running - pick one with -t:`);
      console.error(formatSessions(rows));
      process.exit(1);
    }
  }
  if (!hasSession(sess)) die(`${who}: no tmux session '${sess}'`);
  return sess;
}

// Send one submitted line to the slot panes matching `want` (null = all). Returns targets.
function sendToPanes(session, want, msg) {
  const paneLines = (
    tmuxOut(['list-panes', '-s', '-t', session, '-F', '#{pane_id} #{pane_start_path}']) ?? ''
  ).split('\n');
  const targets = selectPanes(paneLines, docs, PREFIX, want);
  for (const { pid } of targets) sendLine(pid, msg);
  return targets;
}

// Shell command a fresh slot pane runs: resume this dir's most recent Claude conversation
// if a transcript exists, else start fresh (so quitting/Ctrl-C never relaunches).
function claudeCmd(dir) {
  return `if ls ${projectDir(dir)}/*.jsonl >/dev/null 2>&1; then claude -c; else claude; fi`;
}

// Pick the first reusable slot with a live worker, resetting a merged one to a clean base.
async function pickReusable(json, who) {
  const rows = await freenessRows(json, 'finding a free slot...');
  const pick = pickDispatchSlot(rows);
  if (!pick) die(`${who}: no free slot with a live worker (see: sm slot ls)`);
  let reset = false;
  if (pick.status === 'merged') {
    try {
      await resetSlot(PREFIX + pick.slot);
      reset = true;
    } catch (e) {
      die(`${who}: could not reset slot ${pick.slot} - ${e.message}`);
    }
  }
  return { slot: pick.slot, from: pick.status, reset };
}

export async function cmdMsg(argv, who = 'send') {
  const { values, positionals } = parseCmd(who, argv, {
    slots: { type: 'string', short: 's' },
    session: { type: 'string', short: 't' },
    'first-free': { type: 'boolean', short: 'f' },
    brief: { type: 'boolean' },
  });
  if (positionals.length < 1) die(`${who}: a message argument is required (try --help)`);
  if (positionals.length > 1)
    die(`${who}: unexpected extra argument '${positionals[1]}' (did you mean -t ${positionals[1]}?)`);
  if (values['first-free'] && values.slots != null)
    die(`${who}: use either --first-free or --slots, not both`);
  const msg = positionals[0];

  const labels = listSlots().map((n) => n.slice(PREFIX.length));
  if (labels.length === 0) die(`${who}: no ${PREFIX}* worktrees in ${docs} - create one: sm slot create a`);

  let want = null; // null => all slots
  let picked = null; // set when --first-free chose a slot
  if (values['first-free']) {
    picked = await pickReusable(values.json, who);
    want = new Set([picked.slot]);
  } else if (values.slots != null) {
    try {
      want = resolveSlots(values.slots, labels);
    } catch (e) {
      die(`${who}: ${e.message}`);
    }
  }

  const sess = resolveSession(values.session, who);
  const text =
    values.brief && want && want.size === 1
      ? `You are the worker for slot ${[...want][0]} in the slot-machine model - run 'sm worker role' for how to operate here, then do this task: ${msg}`
      : msg;
  const targets = sendToPanes(sess, want, text);
  // slot-machine owns the lock: claim each freshly-tasked slot not already held by a live worker.
  // Skip slash-commands (control messages like /clear, not task dispatch).
  if (!msg.startsWith('/')) {
    const liveWorkers = slotWorkerMap();
    for (const t of targets) {
      const tdir = join(docs, PREFIX + t.lbl);
      if (!(readLock(tdir) && liveWorkers.get(t.lbl) === 'live'))
        writeLock(tdir, { session: sess, pane: t.pid, task: oneLine(msg, 140) });
    }
  }
  const sent = targets.map((t) => t.lbl);
  const missing = want ? [...want].filter((l) => !sent.includes(l)) : [];
  if (!sent.length) process.exitCode = 1; // a dispatch that delivered nothing is not success
  if (values.json) {
    emitJson({
      session: sess,
      sent,
      missing,
      ...(picked ? { picked: picked.slot, from: picked.from, reset: picked.reset } : {}),
    });
    return;
  }
  if (missing.length) console.error(`${who}: warning - no running pane for slot(s): ${missing.join(' ')}`);
  console.log(
    `sent to ${sent.length} slot pane(s) in '${sess}'${picked ? ` (first-free: ${clr.bold(picked.slot)}${picked.reset ? ', reset from merged' : ''})` : ''}`,
  );
}

export function cmdLs(argv = []) {
  const { values } = parseCmd('ls', argv);
  if (values.json) {
    emitJson(sessionRows());
    return;
  }
  console.log(formatSessions(sessionRows(), SESSION_PREFIX));
}

// attach [NAME]: attach/switch the client to a running session - the most recently
// active one by default, so a bare `sm session attach` continues where you left off.
export function cmdAttach(argv) {
  const { values, positionals } = parseCmd('attach', argv);
  let sess = positionals[0] ?? null;
  if (sess && !hasSession(sess)) die(`attach: no tmux session '${sess}'`);
  if (!sess) {
    const out = tmuxOut(['list-sessions', '-F', '#{session_activity}\t#{session_name}']) ?? '';
    sess =
      out
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\t'))
        .filter((c) => c[1] && c[1].startsWith(SESSION_PREFIX))
        .sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1] ?? null;
    if (!sess) die(`attach: no running ${SESSION_PREFIX}* session - build one: sm session create`);
  }
  if (values.json) {
    emitJson({ session: sess }); // resolve-only: report what would be attached
    return;
  }
  attachOrSwitch(sess);
}

// reload [NAME]: append panes for slots created after the session was built, leaving
// every existing pane untouched. Packing (panes per window) is inferred from the densest
// existing slot window. Changing the packing itself is a rebuild: sm session create N -k.
export function cmdReload(argv) {
  const { values, positionals } = parseCmd('reload', argv);
  const sess = resolveSession(positionals[0] ?? null, 'reload');
  const labels = listSlots().map((n) => n.slice(PREFIX.length));
  const paneLines = (
    tmuxOut(['list-panes', '-s', '-t', sess, '-F', '#{pane_id} #{pane_start_path}']) ?? ''
  ).split('\n');
  const present = new Set(selectPanes(paneLines, docs, PREFIX, null).map((t) => t.lbl));
  const missing = labels.filter((l) => !present.has(l));
  if (!missing.length) {
    if (values.json) {
      emitJson({ session: sess, added: [] });
      return;
    }
    console.log(`'${sess}' already shows all ${labels.length} slot(s) - nothing to add`);
    return;
  }

  // slot windows and their pane counts; the densest one defines the packing
  const wins = (
    tmuxOut(['list-windows', '-t', sess, '-F', '#{window_id}\t#{window_name}\t#{window_panes}']) ?? ''
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter((w) => w[1].startsWith('slot-'))
    .map(([id, name, panes]) => ({ id, name, panes: Number(panes) }));
  const perN = Math.max(3, ...wins.map((w) => w.panes));

  const windowLabels = (id) =>
    selectPanes(
      (tmuxOut(['list-panes', '-t', id, '-F', '#{pane_id} #{pane_start_path}']) ?? '').split('\n'),
      docs,
      PREFIX,
      null,
    ).map((t) => t.lbl);

  const touched = new Set();
  for (const lbl of missing) {
    const dir = `${docs}/${PREFIX}${lbl}`;
    let win = wins.find((w) => w.panes < perN);
    let pane;
    if (win) {
      pane = req(
        tmuxOut(['split-window', '-P', '-F', '#{pane_id}', '-h', '-t', win.id, '-c', dir]),
        'split-window',
      ).trim();
      win.panes++;
    } else {
      pane = req(
        tmuxOut(['new-window', '-P', '-F', '#{pane_id}', '-t', sess, '-n', `slot-${lbl}`, '-c', dir]),
        'new-window',
      ).trim();
      const id = (tmuxOut(['display-message', '-p', '-t', pane, '#{window_id}']) ?? '').trim();
      win = { id, name: `slot-${lbl}`, panes: 1 };
      wins.push(win);
    }
    sendLine(pane, claudeCmd(dir));
    touched.add(win.id);
  }
  // window names list their member slots; refresh the ones we grew
  for (const id of touched) {
    tmux(['rename-window', '-t', id, `slot-${windowLabels(id).join(',')}`]);
    tmux(['select-layout', '-t', id, 'even-horizontal']);
  }
  if (values.json) {
    emitJson({ session: sess, added: missing });
    return;
  }
  console.log(`added ${missing.length} slot pane(s) to '${sess}': ${missing.join(' ')}`);
}

// detach [NAME]: detach your own client when run inside tmux with no NAME, else every
// client attached to the named (or sole running) session.
export function cmdDetach(argv) {
  const { values, positionals } = parseCmd('detach', argv);
  if (!positionals.length && process.env.TMUX) {
    if (values.json) emitJson({ detached: 'self' });
    tmux(['detach-client']);
    return;
  }
  const sess = resolveSession(positionals[0] ?? null, 'detach');
  tmux(['detach-client', '-s', sess]);
  if (values.json) {
    emitJson({ session: sess, detached: true });
    return;
  }
  console.log(`detached clients from '${sess}'`);
}

export async function cmdFree(argv) {
  const { values } = parseCmd('ls', argv, {
    free: { type: 'boolean', short: 'q' },
    watch: { type: 'boolean' },
  });
  if (values.json) {
    emitJson(await freenessRows(true));
    return;
  }
  if (values.watch) return watchLoop('sm slot ls', 5000, slotFreenessRows, renderFree);
  const rows = await freenessRows(values.free);
  if (values.free) {
    console.log(
      rows
        .filter((r) => r.free)
        .map((r) => r.slot)
        .join(' '),
    );
    return;
  }
  renderFree(rows);
}

// inspect SLOT: a slot's branch, git state, live/dead worker, lock owner, and every PR.
export async function cmdInfo(argv) {
  const { values, positionals } = parseCmd('inspect', argv);
  const json = values.json;
  if (!positionals.length) die('inspect: name a slot, e.g. sm slot inspect c');
  const { name, label: short, dir, exists } = slotRef(positionals[0]);
  if (!exists) die(`inspect: no worktree ${name} in ${docs}`);

  const stop = json ? () => {} : startSpinner('inspecting slot (git + gh pr)...');
  const { branch, dirty, ahead } = await slotGit(dir);
  const worker = slotWorkerMap().get(short) || 'none';
  const raw = readLock(dir);
  const age = raw && !raw.unparseable ? lockTranscriptAge(raw) : null;
  const lock = !raw
    ? null
    : raw.unparseable
      ? { unparseable: true }
      : {
          session: raw.session,
          ts: raw.ts,
          task: raw.task,
          transcript: raw.transcript,
          owner: raw.owner,
          ageSec: age,
          live: lockIsLive(raw, worker === 'live'),
          crossWired: !!(raw.owner && raw.owner !== short),
        };
  const out = await run('gh', [
    'pr',
    'list',
    '--repo',
    await repoSlug(dir),
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,state,isDraft,title,url',
    '--jq',
    '.[] | [(.number|tostring), .state, (if .isDraft then "draft" else "-" end), .title, .url] | @tsv',
  ]);
  const prs = out.trim()
    ? out
        .trim()
        .split('\n')
        .map((l) => {
          const [number, state, draft, title, url] = l.split('\t');
          return { number: Number(number), state, draft: draft === 'draft', title, url };
        })
    : [];
  stop();

  if (json) {
    emitJson({ slot: short, branch, dirty, ahead, worker, lock, prs });
    return;
  }

  console.log(`${clr.bold(short)}  ${branch}`);
  console.log(
    `  git:    ${dirty ? clr.red('dirty') : 'clean'}${ahead ? `, ${ahead} commit(s) ahead of the base` : ''}`,
  );
  console.log(
    `  worker: ${worker === 'live' ? clr.green('live') : worker === 'dead' ? clr.red('dead (Claude exited)') : clr.dim('none (no pane)')}`,
  );
  if (!lock) console.log(`  lock:   ${clr.green('unlocked')}`);
  else if (lock.unparseable) console.log(`  lock:   ${clr.red('present but unparseable')}`);
  else {
    const life = lock.live ? clr.green('LIVE') : clr.yellow('STALE');
    const activity = lock.ageSec == null ? 'transcript gone' : `active ${fmtAge(lock.ageSec)} ago`;
    const cross = lock.crossWired ? clr.red(`  [transcript is in ${PREFIX}${lock.owner}, not ${short}]`) : '';
    const task = lock.task ? ` for ${oneLine(lock.task, 60)}` : '';
    console.log(
      `  lock:   ${clr.red('locked')} (${life}, ${activity}) by ${lock.session || '?'}${task}${lock.ts ? ` since ${agoStr(lock.ts)}` : ''}${cross}`,
    );
    if (lock.transcript) console.log(`          ${clr.dim(lock.transcript)}`);
    if (!lock.live) console.log(`          ${clr.dim('reclaim: sm lock prune ' + short)}`);
  }
  if (!prs.length) {
    console.log('  prs:    (none for this branch)');
    return;
  }
  console.log('  prs:');
  const SC = { OPEN: 'yellow', MERGED: 'green', CLOSED: 'red' };
  for (const p of prs) {
    const st = (clr[SC[p.state]] || clr.dim)(p.state.toLowerCase() + (p.draft ? ' (draft)' : ''));
    console.log(`    #${p.number}  ${st}  ${p.title}`);
    console.log(`        ${clr.dim(p.url)}`);
  }
}

// Bring a slot worktree back to a clean base (its base branch @ origin/main). Refuses a
// live-locked or dirty slot unless force. Throws on refusal/failure.
async function resetSlot(name, { force = false } = {}) {
  const { label: short, dir, exists } = slotRef(name);
  if (!exists) throw new Error(`no worktree ${name}`);
  const lock = readLock(dir);
  const workerLive = slotWorkerMap().get(short) === 'live';
  if (lockIsLive(lock, workerLive) && !force)
    throw new Error(`${short} is held by a live session (--force to override)`);
  const { dirty } = await slotGit(dir);
  if (dirty && !force) throw new Error(`${short} has uncommitted changes (--force to discard)`);
  await run('git', ['-C', dir, 'fetch', '-q', 'origin', BASE_BRANCH]);
  if (dirty) {
    await run('git', ['-C', dir, 'reset', '--hard']);
    await run('git', ['-C', dir, 'clean', '-fd']);
  }
  const switched = await pexec('git', ['-C', dir, 'switch', name])
    .then(() => true)
    .catch(() => false);
  if (!switched) await run('git', ['-C', dir, 'switch', '-C', name, `origin/${BASE_BRANCH}`]);
  await run('git', ['-C', dir, 'reset', '--hard', `origin/${BASE_BRANCH}`]);
  removeLock(dir); // reclaim: slot-machine releases the lock
  return { slot: short, branch: name };
}

export async function cmdReset(argv) {
  const { values, positionals } = parseCmd('reset', argv, { force: { type: 'boolean' } });
  if (!positionals.length) die('reset: name a slot, e.g. sm slot reset f');
  const { name } = slotRef(positionals[0]);
  const stop = values.json ? () => {} : startSpinner('resetting slot (git fetch)...');
  let res;
  try {
    res = await resetSlot(name, { force: values.force });
  } catch (e) {
    die(`reset: ${e.message}`); // the spinner's exit hook restores the cursor
  } finally {
    stop();
  }
  if (values.json) {
    emitJson({ ...res, reset: true });
    return;
  }
  console.log(`${res.slot}: reset to ${res.branch} @ origin/${BASE_BRANCH} (clean)`);
}

// claim NAME [task]: mark a slot OR a named shared resource busy. A name matching a slot
// worktree writes its .worktree-lock (as before); any other multi-char name is a machine-level
// resource lock (e.g. "browser" = the shared authenticated Playwright browser) - acquired
// atomically, so racing claimants lose cleanly instead of colliding on the resource itself.
export async function cmdClaim(argv) {
  const { values, positionals } = parseCmd('claim', argv, {
    session: { type: 'string', short: 't' },
    slot: { type: 'string', short: 's' },
    wait: { type: 'boolean', short: 'w' },
    force: { type: 'boolean' },
  });
  if (!positionals.length)
    die('claim: name a slot or resource, e.g. sm lock claim f "ABC-123" / sm lock claim browser');
  const name = positionals[0];
  const { label, dir, exists } = slotRef(name);

  if (exists) {
    // slot worktree lock (original behavior)
    const pane = slotPanes().get(label)?.pane ?? null;
    const lock = writeLock(dir, { session: values.session || null, pane, task: positionals[1] || null });
    if (values.json) {
      emitJson({ slot: label, claimed: true, ...lock });
      return;
    }
    console.log(`claimed slot ${clr.bold(label)}${lock.task ? ` for ${lock.task}` : ''}`);
    return;
  }
  // Single-char names are slot labels; a missing worktree there is a typo, not a resource.
  if (name.length === 1) die(`claim: no worktree ${PREFIX}${name} in ${docs}`);

  // Named resource lock. Holder = -s SLOT or auto-detected from cwd.
  const holderSlot = values.slot || detectRole(process.cwd(), docs, PREFIX).slot || null;
  const meta = { slot: holderSlot, task: positionals[1] || null, session: values.session || null };
  const deadline = Date.now() + 10 * 60_000; // --wait caps at 10 min
  for (;;) {
    let r = claimResource(name, meta);
    if (!r.ok && r.holder) {
      // Steal when the holder's worker is dead (stale) or on --force; tiny release->claim race is fine.
      const holderDead = r.holder.slot ? slotWorkerMap().get(r.holder.slot) !== 'live' : false;
      if (holderDead || values.force) {
        releaseResource(name);
        r = claimResource(name, meta);
      }
    }
    if (r.ok) {
      if (values.json) {
        emitJson({ resource: name, claimed: true, ...r.lock });
        return;
      }
      console.log(
        `claimed ${clr.bold(name)}${holderSlot ? ` for slot ${holderSlot}` : ''}${meta.task ? ` (${meta.task})` : ''}`,
      );
      return;
    }
    if (!values.wait || Date.now() > deadline) {
      const h = r.holder;
      const held = h
        ? `held by ${h.slot ? `slot ${h.slot}` : 'unknown'}${h.task ? ` (${h.task})` : ''} since ${agoStr(h.ts)}`
        : 'held';
      if (values.json) {
        emitJson({ resource: name, claimed: false, holder: h });
        process.exit(1);
      }
      die(
        `claim: ${name} is ${held}${values.wait ? ' - wait timed out' : ' (use --wait to queue, --force to steal)'}`,
      );
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

// release NAME: free a slot's .worktree-lock or a named resource lock. Inverse of claim.
export function cmdRelease(argv) {
  const { values, positionals } = parseCmd('release', argv);
  if (!positionals.length)
    die('release: name a slot or resource, e.g. sm lock release f / sm lock release browser');
  const name = positionals[0];
  const { label, dir, exists: isSlot } = slotRef(name);
  if (!isSlot && name.length === 1) die(`release: no worktree ${PREFIX}${name} in ${docs}`);
  const removed = isSlot ? removeLock(dir) : releaseResource(name);
  if (values.json) {
    emitJson({ [isSlot ? 'slot' : 'resource']: isSlot ? label : name, released: removed });
    return;
  }
  console.log(
    removed
      ? `released ${clr.bold(isSlot ? `slot ${label}` : name)}`
      : `${isSlot ? `slot ${label}` : name} was not locked`,
  );
}

// locks: list held resource locks (slot worktree locks show in `sm slot ls`).
export function cmdLocks(argv = []) {
  const { values } = parseCmd('ls', argv);
  const locks = listResourceLocks();
  if (values.json) {
    emitJson(locks);
    return;
  }
  if (!locks.length) {
    console.log('no resource locks held');
    return;
  }
  const workers = slotWorkerMap();
  for (const l of locks) {
    const holder = l.slot
      ? `slot ${l.slot} (${workers.get(l.slot) === 'live' ? clr.green('live') : clr.red('dead')})`
      : 'unknown';
    console.log(`${clr.bold(l.resource)}  ${holder}  ${clr.dim(agoStr(l.ts))}${l.task ? `  ${l.task}` : ''}`);
  }
}

// dispatch MESSAGE - alias for `msg --first-free`: send to the first reusable slot.
export function cmdDispatch(argv) {
  return cmdMsg(['--first-free', ...argv], 'run');
}

// focus SLOT | -f: jump the tmux client to a slot's pane (prefers the attached session).
// With -f/--first-free, target the first free slot instead of a named one.
export async function cmdFocus(argv) {
  const { values, positionals } = parseCmd('focus', argv, {
    'first-free': { type: 'boolean', short: 'f' },
  });
  let arg = positionals[0];
  if (values['first-free'] && arg) die('focus: use either -f or a slot name, not both');
  if (values['first-free']) {
    const rows = await freenessRows(values.json, 'finding a free slot...');
    const pick = rows.find((r) => r.free);
    if (!pick) die('focus: no free slot (see: sm slot ls)');
    arg = pick.slot;
  }
  if (!arg) die('focus: name a slot, e.g. sm slot focus h  (or -f for the first free)');
  const { label: short } = slotRef(arg);
  const hit = slotPanes().get(short);
  if (!hit) die(`focus: no pane for slot ${short} in any running session`);
  if (values.json) {
    emitJson({ slot: short, ...hit });
    return;
  }
  tmux(['select-window', '-t', hit.window]);
  tmux(['select-pane', '-t', hit.pane]);
  if (process.env.TMUX) tmux(['switch-client', '-t', hit.session], { stdio: 'inherit' });
  else process.exit(tmux(['attach', '-t', hit.session], { stdio: 'inherit' }).status ?? 0);
}

const activityColor = (a) => (a === 'working' ? clr.green : a === 'waiting' ? clr.yellow : clr.dim);

// logs SLOT: one worker in depth - activity, last assistant message, pane tail. -f follows.
export async function cmdLogs(argv) {
  const { values, positionals } = parseCmd('logs', argv, {
    lines: { type: 'string', short: 'n' },
    follow: { type: 'boolean', short: 'f' },
  });
  if (!positionals.length) die('logs: name a slot, e.g. sm worker logs h');
  const { name, label: short, dir, exists } = slotRef(positionals[0]);
  if (!exists) die(`logs: no worktree ${name} in ${docs}`);
  const n = Math.max(1, parseInt(values.lines || '20', 10) || 20);

  const snapshot = () => {
    const pane = slotPanes().get(short)?.pane ?? null;
    const capture = pane ? (tmuxOut(['capture-pane', '-p', '-t', pane]) ?? '') : '';
    const capLines = capture.split('\n');
    while (capLines.length && !capLines[capLines.length - 1].trim()) capLines.pop();
    return {
      slot: short,
      pane,
      activity: paneActivity(capture, !!pane),
      lastMessage: lastAssistant(dir),
      tail: capLines.slice(-n),
    };
  };
  const render = (s) => {
    console.log(`${clr.bold(s.slot)}  ${activityColor(s.activity)(s.activity)}`);
    if (s.lastMessage) console.log(`  last: ${clr.dim(oneLine(s.lastMessage, 500))}`);
    console.log(clr.dim(`  --- pane (last ${s.tail.length}) ---`));
    for (const l of s.tail) console.log('  ' + l);
  };

  if (values.json) {
    emitJson(snapshot());
    return;
  }
  if (!values.follow) {
    render(snapshot());
    return;
  }
  return watchLoop(`sm worker logs ${short} -f`, 2000, snapshot, render);
}

// ps: every worker at a glance - live/dead, working/idle/waiting, current task. The cheap
// dispatcher poll (tmux only, no git/gh); `sm slot ls` is the one that decides reusability.
export async function cmdPs(argv) {
  const { values } = parseCmd('ps', argv, { watch: { type: 'boolean' } });
  const labels = listSlots().map((s) => s.slice(PREFIX.length));
  if (!labels.length) die(`ps: no ${PREFIX}* worktrees in ${docs} - create one: sm slot create a`);

  const snapshot = () => {
    const workers = slotWorkerMap();
    const panes = slotPanes();
    return labels.map((lbl) => {
      const worker = workers.get(lbl) || 'none';
      const pane = panes.get(lbl)?.pane ?? null;
      const activity =
        worker === 'live'
          ? paneActivity(pane ? (tmuxOut(['capture-pane', '-p', '-t', pane]) ?? '') : '', !!pane)
          : '-';
      const task = readLock(join(docs, PREFIX + lbl))?.task ?? null;
      return { slot: lbl, worker, activity, task };
    });
  };
  const render = (rows) => {
    const lw = Math.max(4, ...rows.map((r) => r.slot.length));
    const aw = Math.max(8, ...rows.map((r) => r.activity.length));
    console.log(clr.dim(`${pad('slot', lw)} ${pad('worker', 6)} ${pad('activity', aw)} task`));
    for (const r of rows) {
      const worker = (r.worker === 'live' ? clr.green : r.worker === 'dead' ? clr.red : clr.dim)(
        pad(r.worker, 6),
      );
      const activity = activityColor(r.activity)(pad(r.activity, aw));
      const task = r.task ? oneLine(r.task, 60) : clr.dim('-');
      console.log(`${clr.bold(pad(r.slot, lw))} ${worker} ${activity} ${task}`);
    }
  };

  if (values.json) {
    emitJson(snapshot());
    return;
  }
  if (!values.watch) {
    render(snapshot());
    return;
  }
  return watchLoop('sm worker ps', 5000, snapshot, render);
}

// kill SLOT: end one worker's process; its pane falls back to a shell (worker shows dead)
// and the session stays intact. The conversation survives on disk - `claude -c` resumes it.
export async function cmdWorkerKill(argv) {
  const { values, positionals } = parseCmd('kill', argv);
  const json = values.json;
  if (!positionals.length) die('kill: name a slot, e.g. sm worker kill h');
  const { name, label, exists } = slotRef(positionals[0]);
  if (!exists) die(`kill: no worktree ${name} in ${docs}`);
  const pane = slotPanes().get(label)?.pane;
  if (!pane) die(`kill: no pane for slot ${label} in any running session`);
  const panePid = (tmuxOut(['display-message', '-p', '-t', pane, '#{pane_pid}']) ?? '').trim();
  if (!panePid) die(`kill: could not resolve the pane process for slot ${label}`);
  // The worker runs as the pane shell's child (cmdBuild types the claude command into a
  // fresh shell), so ending the children leaves the pane at its shell.
  const pids = (await run('pgrep', ['-P', panePid]))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!pids.length) {
    if (json) {
      emitJson({ slot: label, killed: false, reason: 'no worker process (pane is at a shell)' });
      process.exit(1);
    }
    die(`kill: slot ${label} has no worker process (its pane is already at a shell)`);
  }
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (json) {
    emitJson({ slot: label, killed: true, pids: pids.map(Number) });
    return;
  }
  console.log(`killed worker in slot ${clr.bold(label)} (pid ${pids.join(', ')}) - pane is back at a shell`);
}

export function cmdKill(argv) {
  const { values, positionals } = parseCmd('kill', argv, { all: { type: 'boolean' } });

  let names = positionals;
  if (values.all) {
    names = slotSessions().map((s) => s.name);
    if (!names.length) {
      if (values.json) emitJson([]);
      else console.log(`no running ${SESSION_PREFIX}* tmux sessions`);
      return;
    }
  } else if (names.length === 0) {
    if (values.json) die('kill: name a session, or --all');
    console.error(`kill: name a session, or --all for every ${SESSION_PREFIX}* session:`);
    console.error(formatSessions(sessionRows(), SESSION_PREFIX));
    process.exit(1);
  }

  const results = [];
  for (const name of names) {
    if (!hasSession(name)) {
      results.push({ session: name, killed: false, reason: 'no such session' });
      continue;
    }
    tmux(['kill-session', '-t', name]);
    results.push({ session: name, killed: true });
  }
  if (values.json) {
    emitJson(results);
    if (!results.some((r) => r.killed)) process.exitCode = 1;
    return;
  }
  for (const r of results)
    console.log(r.killed ? `killed '${r.session}'` : `kill: no session '${r.session}'`);
  if (!results.some((r) => r.killed)) process.exit(1);
}

// unlock: deterministically remove stale worktree locks (owner session dead). Live locks
// are kept unless --force. --stale scans all slots; --dry-run previews.
export async function cmdUnlock(argv) {
  const { values, positionals } = parseCmd('prune', argv, {
    stale: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    'older-than': { type: 'string' },
  });
  const thresholdSec = (parseInt(values['older-than'] || '30', 10) || 30) * 60;

  let names;
  if (values.stale) names = listSlots();
  else if (positionals.length) names = positionals.map((a) => slotRef(a).name);
  else die('prune: name a slot, or --stale to clear every dead lock (add --dry-run to preview)');

  const results = [];
  const workers = slotWorkerMap();
  for (const name of names) {
    const { label: short, dir, exists } = slotRef(name);
    if (!exists) {
      results.push({ slot: short, action: 'error', reason: 'no worktree' });
      continue;
    }
    const lock = readLock(dir);
    if (!lock) {
      results.push({ slot: short, action: 'not-locked' });
      continue;
    }
    const age = lockTranscriptAge(lock);
    const live = workers.get(short) === 'live';
    const stale = !lockIsLive(lock, live, thresholdSec);
    if (!stale && !values.force) {
      results.push({ slot: short, action: 'kept', reason: 'live', ageSec: age, live });
      continue;
    }
    if (values['dry-run']) {
      results.push({
        slot: short,
        action: 'would-unlock',
        reason: stale ? 'stale' : 'forced',
        ageSec: age,
        live,
      });
      continue;
    }
    try {
      removeLock(dir);
      results.push({
        slot: short,
        action: 'unlocked',
        reason: stale ? 'stale' : 'forced',
        ageSec: age,
        live,
      });
    } catch (e) {
      results.push({ slot: short, action: 'error', reason: e.message });
    }
  }

  const failed = results.some((r) => r.action === 'error');
  if (values.json) {
    emitJson(results);
    if (failed) process.exitCode = 1;
    return;
  }
  for (const r of results) {
    const activity =
      r.ageSec != null
        ? `active ${fmtAge(r.ageSec)} ago`
        : r.live
          ? 'worker live, no transcript'
          : 'worker dead';
    if (r.action === 'not-locked') {
      if (!values.stale) console.log(`${r.slot}: not locked`);
    } else if (r.action === 'kept')
      console.log(
        `${r.slot}: ${clr.green('LIVE')} lock (${activity}) - kept${values.stale ? '' : ' (use --force to override)'}`,
      );
    else if (r.action === 'would-unlock')
      console.log(`${r.slot}: would unlock (${r.reason === 'stale' ? 'owner dead, ' + activity : 'forced'})`);
    else if (r.action === 'unlocked')
      console.log(
        `${r.slot}: ${clr.green('unlocked')} (${r.reason === 'stale' ? 'owner dead, ' + activity : 'forced'})`,
      );
    else console.error(`${r.slot}: ${r.reason}`);
  }
  if (values.stale && !values['dry-run'])
    console.log(clr.dim(`\n${results.filter((r) => r.action === 'unlocked').length} lock(s) removed`));
  if (failed) process.exitCode = 1;
}

// add LABEL [base]: create a new slot worktree <root>/<prefix><label> on its base branch
// <prefix><label> off origin/<base>. Uses an existing slot to locate the shared repo.
export async function cmdAdd(argv) {
  const { values, positionals } = parseCmd('create', argv);
  if (!positionals.length) die('create: name a slot, e.g. sm slot create l');
  const { name, label, dir, exists } = slotRef(positionals[0]);
  const base = positionals[1] || BASE_BRANCH;
  if (exists) die(`create: ${name} already exists`);
  // Any worktree of the repo can add another; the repo's main worktree is always present.
  const anchor = REPO_DIR;
  if (!anchor || !existsSync(anchor))
    die(`create: repo not found${REPO_DIR ? ` at ${REPO_DIR}` : ''}; run: sm repo use <repo>`);

  const stop = values.json ? () => {} : startSpinner('creating slot (git fetch + worktree add)...');
  await run('git', ['-C', anchor, 'fetch', '-q', 'origin', base]); // best-effort
  let from = null;
  let err = null;
  for (const start of [`origin/${base}`, base]) {
    // new base branch off origin, else local base
    err = await pexec('git', ['-C', anchor, 'worktree', 'add', dir, '-b', name, start])
      .then(() => null)
      .catch((e) => e);
    if (!err) {
      from = start;
      break;
    }
  }
  if (err) {
    // branch already exists
    err = await pexec('git', ['-C', anchor, 'worktree', 'add', dir, name])
      .then(() => null)
      .catch((e) => e);
    if (!err) from = `existing branch ${name}`;
  }
  stop();
  if (err) die(`create: git worktree add failed - ${(err.stderr || err.message || '').trim()}`);

  if (values.json) {
    emitJson({ slot: label, dir, branch: name, base, from });
    return;
  }
  console.log(`created slot ${clr.bold(label)}  ${dir}  (branch ${name} @ ${from})`);
  console.log(clr.dim('  next: sm session create to lay it out'));
}

// rm LABEL: remove a slot worktree. Refuses a live-locked or dirty worktree unless --force.
export async function cmdRm(argv) {
  const { values, positionals } = parseCmd('rm', argv, {
    force: { type: 'boolean' },
  });
  if (!positionals.length) die('rm: name a slot, e.g. sm slot rm l');
  const { name, label, dir, exists } = slotRef(positionals[0]);
  if (!exists) die(`rm: no worktree ${name} in ${docs}`);
  const lock = readLock(dir);
  const workerLive = slotWorkerMap().get(label) === 'live';
  if (lockIsLive(lock, workerLive) && !values.force)
    die(`rm: ${label} is held by a live session (--force to override)`);
  removeLock(dir); // the lock is sm's artifact; removing the worktree discards it
  // git worktree remove must run from a different worktree; the repo's main is always one.
  const anchor = REPO_DIR;
  if (!anchor || !existsSync(anchor))
    die(`rm: repo not found${REPO_DIR ? ` at ${REPO_DIR}` : ''}; run: sm repo use <repo>`);

  const err = await pexec('git', [
    '-C',
    anchor,
    'worktree',
    'remove',
    ...(values.force ? ['--force'] : []),
    dir,
  ])
    .then(() => null)
    .catch((e) => e);
  if (err)
    die(
      `rm: git worktree remove failed - ${(err.stderr || err.message || '').trim()} (try --force if it has changes)`,
    );
  if (values.json) {
    emitJson({ slot: label, removed: true });
    return;
  }
  console.log(`removed slot ${clr.bold(label)}  ${dir}`);
}

// use [REPO]: set the current repo to a git repo, or show current + known repos.
// repo ls: the known repos, current marked.
export function cmdRepoLs(argv) {
  const { values } = parseCmd('ls', argv);
  const cfg = loadConfig();
  if (values.json) {
    emitJson({ current: cfg.current || null, repos: cfg.repos || {} });
    return;
  }
  if (!cfg.current) console.log('no current repo - set one with: sm repo use <repo>');
  for (const [dir, c] of Object.entries(cfg.repos || {})) {
    const mark = dir === cfg.current ? clr.green('*') : ' ';
    console.log(
      `${mark} ${clr.bold(c.name)}  ${dir}  (prefix ${c.prefix}, session ${c.sessionPrefix}, base ${c.baseBranch})`,
    );
  }
}

// repo inspect [REPO]: one repo's resolved context (the current repo by default).
export function cmdRepoInspect(argv) {
  const { values, positionals } = parseCmd('inspect', argv);
  const cfg = loadConfig();
  const key = positionals[0] ? mainWorktree(resolve(positionals[0])) || resolve(positionals[0]) : cfg.current;
  if (!key) die('inspect: no current repo - run: sm repo use <repo>');
  const c = cfg.repos?.[key];
  if (!c) die(`inspect: unknown repo ${key} (sm repo ls shows known repos)`);
  if (values.json) {
    emitJson({ repoDir: key, current: key === cfg.current, ...c });
    return;
  }
  console.log(`${clr.bold(c.name)}  ${key}${key === cfg.current ? clr.green('  (current)') : ''}`);
  console.log(`  root     ${c.root}`);
  console.log(`  prefix   ${c.prefix}`);
  console.log(`  session  ${c.sessionPrefix}*`);
  console.log(`  base     ${c.baseBranch}`);
}

// repo rm REPO: forget a repo (config only - nothing on disk is touched).
export function cmdRepoRm(argv) {
  const { values, positionals } = parseCmd('rm', argv);
  if (!positionals.length) die('rm: name a repo to forget, e.g. sm repo rm ~/code/acme');
  const cfg = loadConfig();
  const repos = cfg.repos || {};
  const arg = positionals[0];
  const asPath = mainWorktree(resolve(arg)) || resolve(arg);
  const key = repos[asPath] ? asPath : Object.keys(repos).filter((d) => repos[d].name === arg)[0];
  if (!key || !repos[key]) die(`rm: unknown repo '${arg}' (sm repo ls shows known repos)`);
  const wasCurrent = cfg.current === key;
  delete cfg.repos[key];
  if (wasCurrent) cfg.current = null;
  saveConfig(cfg);
  if (values.json) {
    emitJson({ repoDir: key, removed: true, currentCleared: wasCurrent });
    return;
  }
  console.log(
    `forgot ${clr.bold(key)} (config only - nothing on disk touched)${wasCurrent ? ' - no current repo now' : ''}`,
  );
}

export function cmdUse(argv) {
  const { values, positionals } = parseCmd('use', argv, {
    prefix: { type: 'string' },
    session: { type: 'string' },
    base: { type: 'string' },
  });
  if (!positionals.length)
    die('use: name a repo, e.g. sm repo use ~/code/acme  (sm repo ls shows known repos)');

  const cfg = loadConfig();
  const main = mainWorktree(resolve(positionals[0]));
  if (!main) die(`use: not a git repository: ${positionals[0]}`);
  const c = deriveContext(main, {
    prefix: values.prefix,
    sessionPrefix: values.session,
    baseBranch: values.base,
  });
  if (!values.base) c.baseBranch = defaultBranch(main);
  cfg.repos ||= {};
  cfg.repos[main] = {
    name: c.name,
    root: c.root,
    prefix: c.prefix,
    sessionPrefix: c.sessionPrefix,
    baseBranch: c.baseBranch,
  };
  cfg.current = main;
  saveConfig(cfg);
  if (values.json) {
    emitJson({ current: main, ...cfg.repos[main] });
    return;
  }
  console.log(`using ${clr.bold(c.name)}  ${main}`);
  console.log(`  root ${c.root}  prefix ${c.prefix}  session ${c.sessionPrefix}*  base ${c.baseBranch}`);
}

// doctor: check that the environment + config are healthy for slot to work.
export async function cmdDoctor(argv) {
  const { values } = parseCmd('doctor', argv, {
    fix: { type: 'boolean' },
    'fix-tmux': { type: 'boolean' },
  });
  const fix = values.fix;
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  const ver = async (cmd, args) => (await run(cmd, args)).trim().split('\n')[0];
  const stopSpin = values.json ? () => {} : startSpinner('running checks...');

  const tmuxV = await ver('tmux', ['-V']);
  add('tmux', tmuxV ? 'ok' : 'fail', tmuxV || 'not found on PATH');

  // --fix / --fix-tmux: upsert sm's pane-title block into the user's tmux.conf, apply it
  // to a running server, then fall through so the normal checks verify the result.
  if (fix || values['fix-tmux']) {
    const { path, changed } = writeTmuxBlock();
    if (tmuxV) for (const [opt, val] of TMUX_SETTINGS) tmux(['set', '-g', opt, val]);
    add(
      'tmux config',
      'ok',
      changed ? `wrote pane-title block to ${path}` : `block already present in ${path}`,
    );
  }
  // Pane titles: with N worker panes, the border title is how you tell them apart.
  const titles = tmuxTitlesStatus((tmuxOut(['show-options', '-gv', 'pane-border-status']) ?? '').trim());
  add(
    'tmux pane titles',
    titles.ok ? 'ok' : 'warn',
    titles.ok
      ? `pane-border-status ${titles.value} (${titles.source})`
      : 'off - worker panes are hard to tell apart; fix: sm doctor --fix',
  );
  const gitV = await ver('git', ['--version']);
  add('git', gitV ? 'ok' : 'fail', gitV || 'not found on PATH');
  const ghV = await ver('gh', ['--version']);
  add('gh', ghV ? 'ok' : 'warn', ghV || 'not found - PR state unavailable, slots may misclassify');
  add('node', 'ok', process.version);
  const claudeV = await ver('claude', ['--version']);
  add(
    'claude',
    claudeV ? 'ok' : 'warn',
    claudeV || 'not found - worker panes will have nothing to run (install Claude Code)',
  );
  if (ghV) {
    const authed = await pexec('gh', ['auth', 'status'])
      .then(() => true)
      .catch(() => false);
    add(
      'gh auth',
      authed ? 'ok' : 'warn',
      authed ? 'authenticated' : 'not logged in (gh auth login) - PR state unavailable',
    );
  }

  // Bin symlinks in ~/.local/bin (--fix creates/repairs; never clobbers a real file).
  const links = BINS.map(linkStatus);
  if (fix)
    for (const s of links)
      if (fixLink(s) === 'fixed') {
        s.status = 'ok';
        s.fixed = true;
      }
  const badLinks = links.filter((s) => s.status !== 'ok');
  add(
    'bin links',
    badLinks.length ? 'warn' : 'ok',
    badLinks.length
      ? `${badLinks.map((s) => `${s.name}: ${s.status}`).join(', ')} - fix: sm doctor --fix`
      : `${BINS.join(', ')} -> ${join(PKG_ROOT, 'bin')}${links.some((s) => s.fixed) ? ' (installed)' : ''}`,
  );
  add(
    'PATH',
    binDirOnPath() ? 'ok' : 'warn',
    binDirOnPath() ? `${BIN_DIR} is on PATH` : `${BIN_DIR} is not on PATH - add it in your shell rc`,
  );

  // MCP registration with Claude Code ('slot' tolerated as an older registration name).
  if (claudeV) {
    const reg = (n) =>
      pexec('claude', ['mcp', 'get', n])
        .then(() => n)
        .catch(() => null);
    let name = (await reg('slot-machine')) || (await reg('slot'));
    if (!name && fix) {
      const added = await pexec('claude', [
        'mcp',
        'add',
        'slot-machine',
        '-s',
        'user',
        '--',
        join(BIN_DIR, 'slot-machine-mcp'),
      ])
        .then(() => true)
        .catch(() => false);
      if (added) name = 'slot-machine (registered)';
    }
    add('mcp server', name ? 'ok' : 'warn', name || 'not registered with Claude Code - fix: sm doctor --fix');
  }

  const cfg = configReport();
  add('config file', cfg.fileOk ? 'ok' : 'ok', cfg.fileOk ? cfg.path : 'none yet');
  add(
    'repo',
    REPO_DIR ? 'ok' : 'warn',
    REPO_DIR ? `${REPO_NAME}  ${REPO_DIR}` : 'none set - run: sm repo use <repo>',
  );
  if (cfg.values) for (const [k, v] of Object.entries(cfg.values)) add(`  ${k}`, 'ok', String(v));

  if (REPO_DIR) {
    const rootOk = existsSync(docs);
    add('root dir', rootOk ? 'ok' : 'fail', rootOk ? docs : `${docs} missing`);
    const slots = rootOk ? listSlots() : [];
    add(
      'slots',
      slots.length ? 'ok' : 'warn',
      slots.length
        ? `${slots.length}: ${slots.map((s) => s.slice(PREFIX.length)).join(',')}`
        : `no ${PREFIX}* worktrees in ${docs}`,
    );
    if (slots.length) {
      const dir = join(docs, slots[0]);
      const slug = await repoSlug(dir);
      add('origin remote', slug ? 'ok' : 'warn', slug || 'no origin remote - gh PR lookups will fail');
      const baseOk = await pexec('git', ['-C', dir, 'rev-parse', '--verify', `origin/${BASE_BRANCH}`])
        .then(() => true)
        .catch(() => false);
      add(
        `base origin/${BASE_BRANCH}`,
        baseOk ? 'ok' : 'warn',
        baseOk ? 'resolvable' : `not found - run: git -C <slot> fetch origin ${BASE_BRANCH}`,
      );
    }
  }

  stopSpin();
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  if (values.json) {
    emitJson({ ok: fails === 0, fails, warns, checks });
    if (fails) process.exitCode = 1;
    return;
  }
  const mark = { ok: clr.green('ok  '), warn: clr.yellow('warn'), fail: clr.red('fail') };
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) console.log(`  ${mark[c.level]}  ${c.name.padEnd(w)}  ${clr.dim(c.detail)}`);
  console.log(
    `\n${fails ? clr.red(`${fails} problem(s)`) : clr.green('healthy')}${warns ? clr.yellow(`, ${warns} warning(s)`) : ''}`,
  );
  if (fails) process.exit(1);
}

export function cmdBuild(argv) {
  const { values, positionals } = parseCmd('create', argv, { kill: { type: 'boolean', short: 'k' } });

  const per = positionals[0] ?? '3';
  if (!['2', '3', '4'].includes(per))
    die(`create: panes per window must be 2, 3, or 4 (got '${per}'); try --help`);
  const perN = Number(per);
  const session = positionals[1] ?? `${SESSION_PREFIX}${per}`;

  if (values.kill) tmux(['kill-session', '-t', session]); // ignore errors
  if (hasSession(session)) {
    attachOrSwitch(session);
    return;
  }

  const slots = listSlots(); // full names: acme-slot-a ...
  if (slots.length === 0) die(`create: no ${PREFIX}* worktrees in ${docs} - create one: sm slot create a`);

  // Honor the user's tmux base-index so window numbering matches their config.
  let bidx = parseInt((tmuxOut(['show-options', '-gv', 'base-index']) ?? '0').trim(), 10);
  if (!Number.isFinite(bidx)) bidx = 0;

  tmux(['new-session', '-d', '-s', session, '-n', 'desk', '-c', docs]); // window <bidx>: desk shell

  let win = bidx + 1;
  for (let i = 0; i < slots.length; i += perN) {
    const group = slots.slice(i, i + perN);
    const label = group.map((s) => s.slice(PREFIX.length)).join(',');
    const target = `${session}:${win}`;
    let pane = req(
      tmuxOut([
        'new-window',
        '-P',
        '-F',
        '#{pane_id}',
        '-t',
        target,
        '-n',
        `slot-${label}`,
        '-c',
        `${docs}/${group[0]}`,
      ]),
      'new-window',
    ).trim();
    sendLine(pane, claudeCmd(`${docs}/${group[0]}`));
    for (let p = 1; p < group.length; p++) {
      pane = req(
        tmuxOut(['split-window', '-P', '-F', '#{pane_id}', '-h', '-t', target, '-c', `${docs}/${group[p]}`]),
        'split-window',
      ).trim();
      sendLine(pane, claudeCmd(`${docs}/${group[p]}`));
    }
    tmux(['select-layout', '-t', target, 'even-horizontal']);
    win++;
  }

  tmux(['select-window', '-t', `${session}:${bidx}`]);
  attachOrSwitch(session);
}
