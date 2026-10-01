// sm watch: the supervision core. Gather evidence (IO), classify (pure - lib/slots/verbs.mjs),
// emit a digest. `--check` is the primitive every delivery surface calls; blocking mode loops it.
// PURE OBSERVER: never types into panes, claims nothing, consumes nothing - its only writes are
// the surfaced watermark, journal facts, and its own armed marker. Design notes: README.md here.
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  CRASH_RESAMPLE_MS,
  DAEMON_TIMEOUT_SEC,
  DIGEST_MAX,
  DOCS,
  HOOK_BLOCK_BUDGET,
  PREFIX,
  REPO_DIR,
  REPO_NAME,
  SNAPSHOT_POLL_SEC,
  WATCH_RETRY_MS,
  WATCH_TIMEOUT_MS,
} from '../constants.mjs';
import { agoStr, clr, die, emitJson, oneLine } from '../format.mjs';
import { advanceCursor, inboxStateDir, readCursor, readInbox, waitForReports } from '../inbox.mjs';
import { appendJournal, readJournal } from '../slots/journal.mjs';
import { classify } from '../slots/verbs.mjs';
import { listSlots, prMapChecked, repoSlug, slotGit } from '../exec.mjs';
import { slotPanes, slotWorkerSample } from '../slots/gather.mjs';
import { pidIdentityLive, readLock } from '../slots/locks.mjs';
import { mux } from '../mux/index.mjs';
import { activityOf, loadRoster } from '../agents/index.mjs';
import { argOptions, parseCmd } from './shared.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Gather the classify() evidence that needs IO: claims, worker samples (with the in-run
 * crash resample), activity, and the checked PR map. Inbox/journal/cursor state stays in
 * runCheck (env-seamed, hermetic in tests); this live-world part is injectable via `world`.
 * @returns {Promise<object>} {slots, workersA, workersB, activity, snapshotOk, prs}.
 */
async function gatherWorld() {
  await loadRoster();
  const labels = listSlots().map(name => name.slice(PREFIX.length));
  const slots = labels.map((slot) => {
    const lock = readLock(join(DOCS, PREFIX + slot));
    return { slot, claim: lock ? { ts: lock.ts ?? 0, task: lock.task ?? null } : null };
  });
  const sampleA = slotWorkerSample();
  // In-run crash debounce: a second sample only when a claimed slot looks down (the happy
  // path pays nothing); classify needs both samples to agree before calling it a crash.
  let workersB = null;
  if (sampleA.ok) {
    const down = slot => ['dead', 'none'].includes(sampleA.workers[slot] ?? 'none');
    if (slots.some(({ slot, claim }) => claim && down(slot))) {
      await sleep(CRASH_RESAMPLE_MS);
      const sampleB = slotWorkerSample();
      workersB = sampleB.ok ? sampleB.workers : null;
    }
  }
  // Activity sample for stalled-working: live slots only, one capture each.
  const activity = {};
  if (sampleA.ok) {
    const panes = slotPanes();
    for (const slot of labels) {
      if (sampleA.workers[slot] !== 'live')
        continue;
      const pane = panes.get(slot)?.pane ?? null;
      const cap = pane ? mux('capture', { paneId: pane }) : null;
      activity[slot] = activityOf(REPO_DIR, slot, cap?.ok ? cap.value : '', !!pane);
    }
  }
  // Checked PR map, keyed by slot via each claimed slot's branch. ok:false flows through
  // to classify (omit pr events) and into a digest note - never read as "no PRs".
  const checked = await prMapChecked(await repoSlug(REPO_DIR));
  const bySlot = {};
  if (checked.ok) {
    for (const { slot, claim } of slots) {
      if (!claim)
        continue;
      const { branch } = await slotGit(join(DOCS, PREFIX + slot));
      bySlot[slot] = checked.map.get(branch) ?? [];
    }
  }
  return { slots, workersA: sampleA.workers, workersB, activity, snapshotOk: sampleA.ok, prs: { ok: checked.ok, bySlot } };
}

// One digest line per event; verb/type tag first so the eye can triage.
const TAG_COLOR = { 'done': clr.green, 'blocked': clr.red, 'needs-decision': clr.red, 'failed': clr.red, 'crash': clr.red, 'needs-input': clr.red, 'pr-merged': clr.green };
function eventLine(event) {
  const paint = TAG_COLOR[event.verb ?? event.type] ?? clr.yellow;
  const tag = paint(`[${event.type === 'report' ? event.verb ?? 'report' : event.type}]`);
  switch (event.type) {
    case 'report':
      return `${tag} ${clr.bold(event.slot ?? '-')} ${clr.dim(agoStr(event.ts))}  ${oneLine(event.message, 90)}`;
    case 'stale-paused':
      return `${tag} ${clr.bold(event.slot)} paused ${agoStr(event.reportTs)}: ${oneLine(event.reason, 70)}`;
    case 'stalled-working':
      return `${tag} ${clr.bold(event.slot)} last said working ${agoStr(event.reportTs)}, activity now: ${event.activity}`;
    case 'needs-input':
      return `${tag} ${clr.bold(event.slot)} is waiting on a prompt - nothing will move until someone answers${event.task ? ` (task: ${oneLine(event.task, 50)})` : ''}`;
    case 'crash':
      return `${tag} ${clr.bold(event.slot)} worker gone with a live claim${event.task ? ` (task: ${oneLine(event.task, 60)})` : ''}`;
    case 'pr-merged':
      return `${tag} ${clr.bold(event.slot)} PR #${event.pr} merged - slot reclaimable`;
    case 'watch-degraded':
      return `${tag} ${event.reason}`;
    default:
      return `${tag} ${event.slot ?? ''}`;
  }
}

/**
 * The one-shot check: read inbox/cursor/journal (env-seamed), gather or accept the live
 * world, classify, cap the digest, ack durably when asked, print. Ack order: durable
 * record (journal facts, watermark) BEFORE the signal (stdout); a failed write
 * degrades to a digest note and never suppresses emission.
 * @param {object} [options] - Check options.
 * @param {boolean} [options.ack] - Durably surface: journal facts + advance the watermark.
 * @param {boolean} [options.json] - Machine output.
 * @param {object|null} [options.world] - Injected evidence world (tests); default gathers live.
 * @param {number|null} [options.now] - Injected clock (tests).
 * @param {boolean} [options.print] - Print the digest (the hook path formats its own).
 * @returns {Promise<{emitted: object[], overflow: number, notes: string[], exitCode: number}>} the digest.
 */
export async function runCheck({ ack = false, json = false, world = null, now = null, print = true } = {}) {
  const entries = readInbox(REPO_NAME);
  const notes = [];

  // First ack with no watermark: baseline NOW instead of deluging the whole backlog into
  // one digest - the backlog stays readable via `sm msg inbox --unread`.
  if (ack && readCursor(REPO_NAME, 'surfaced') === 0 && entries.length) {
    advanceCursor(REPO_NAME, 'surfaced', entries.at(-1).ts);
    notes.push(`baseline set: ${entries.length} existing report(s) skipped - read them with sm msg inbox --unread`);
  }

  const surfacedTs = readCursor(REPO_NAME, 'surfaced');
  const journal = readJournal(REPO_NAME, { tail: 1000 });
  const evidence = world ?? await gatherWorld();
  const { surface, absorbed } = classify({ entries, surfacedTs, journal, now: now ?? Date.now(), ...evidence });
  if (evidence.prs && !evidence.prs.ok)
    notes.push('gh poll failed - PR-based events omitted this check');
  if (evidence.snapshotOk === false)
    notes.push('mux snapshot failed - pane-based events omitted this check');

  const emitted = surface.slice(0, DIGEST_MAX);
  const overflow = surface.length - emitted.length;

  if (ack && emitted.length) {
    // Journal the dedup facts for EMITTED events only - overflow re-fires next ack, so a
    // capped digest drains batch by batch instead of silently marking everything surfaced.
    try {
      for (const event of emitted) {
        if (event.type === 'stale-paused' || event.type === 'stalled-working' || event.type === 'needs-input')
          appendJournal(REPO_NAME, { slot: event.slot, type: 'surfaced', reason: event.type });
        else if (event.type === 'crash')
          appendJournal(REPO_NAME, { slot: event.slot, type: 'surfaced', reason: 'crash', claimTs: event.claimTs });
        else if (event.type === 'pr-merged')
          appendJournal(REPO_NAME, { slot: event.slot, type: 'pr-merged', pr: event.pr });
      }
      appendJournal(REPO_NAME, {
        type: 'delivered',
        slots: [...new Set(emitted.map(event => event.slot).filter(Boolean))],
        count: emitted.length,
      });
    }
    catch (err) {
      notes.push(`journal append failed (${err.message}) - facts not recorded; events will re-fire`);
    }
    // Watermark through emitted REPORT entries only; ack never touches the read cursor.
    const reportTs = emitted.filter(event => event.type === 'report').map(event => event.ts);
    if (reportTs.length) {
      try {
        advanceCursor(REPO_NAME, 'surfaced', Math.max(...reportTs));
      }
      catch (err) {
        notes.push(`watermark advance failed (${err.message}) - reports will re-surface`);
      }
    }
  }

  const exitCode = emitted.length || notes.length ? 0 : 3;
  if (json && print) {
    emitJson({ events: emitted, overflow, absorbed, notes, acked: ack });
  }
  else if (exitCode === 0 && print) {
    for (const note of notes) console.log(clr.dim(`note: ${note}`));
    for (const event of emitted) console.log(eventLine(event));
    if (overflow > 0)
      console.log(clr.dim(`and ${overflow} more - sm msg inbox --unread`));
  }
  return { emitted, overflow, notes, exitCode };
}

// --- hook delivery: the seat-gated protocol shim over runCheck -------------------------
// The agent plugin installs `sm watch --check --ack --hook <type>` into the DESK PROJECT's
// settings; this is the command those hooks run. Hook protocol: blocking = exit 2 + reason
// on stderr (stdout ignored); context = exit 0 + {hookSpecificOutput: {hookEventName,
// additionalContext}}; exit 0 with no output = no action. Loop prevention is OUR budget
// counter - the protocol offers none.

const budgetPath = repo => join(inboxStateDir(), `${repo || 'default'}.hook-blocks.json`);
// ponytail: a bare {count} JSON, no schema - internal liveness counter, not a contract.
function readBudget(repo) {
  try {
    return JSON.parse(readFileSync(budgetPath(repo), 'utf8')).count ?? 0;
  }
  catch {
    return 0;
  }
}
function writeBudget(repo, count) {
  mkdirSync(inboxStateDir(), { recursive: true });
  writeFileSync(budgetPath(repo), `${JSON.stringify({ count })}\n`);
}

/**
 * The --hook path: seat-gate, check+ack, shape output per the hook protocol. Exported for
 * hermetic tests (the CLI wrapper prints/exits).
 * @param {object} options - Hook options.
 * @param {'stop'|'prompt-submit'} options.type - Which hook event is calling.
 * @param {object|null} [options.world] - Injected world (tests).
 * @param {number|null} [options.now] - Injected clock (tests).
 * @returns {Promise<{exitCode: number, out: string, errText: string}>} what to print/exit.
 */
export async function runHook({ type, world = null, now = null }) {
  // SEAT GATE - the --hook path ONLY (bare --check/--ack never consult the seat; a peek is
  // always safe from any seat). Every session in the desk project runs the installed hook,
  // but only the delivery seat speaks. Env inheritance into hook subprocesses is
  // undocumented, so the gate fails CLOSED - no ack, no output, exit 0.
  if (!hasSeat())
    return { exitCode: 0, out: '', errText: '' };
  const { emitted, overflow, notes } = await runCheck({ ack: true, world, now, print: false });
  const lines = [
    ...notes.map(note => `note: ${note}`),
    ...emitted.map(eventLine),
    ...(overflow > 0 ? [`and ${overflow} more - sm msg inbox --unread`] : []),
  ];
  if (!lines.length) {
    if (type === 'stop')
      writeBudget(REPO_NAME, 0); // clean pass: the consecutive-block budget resets
    return { exitCode: 0, out: '', errText: '' };
  }
  const digest = lines.join('\n');
  if (type === 'stop') {
    const blocks = readBudget(REPO_NAME);
    if (blocks >= HOOK_BLOCK_BUDGET) {
      // Degraded-allow: a broken check or a noisy fleet must never wedge the session.
      // Speak as context and let the stop happen; only a clean pass resets.
      const context = `[sm watch] block budget exhausted (${blocks} consecutive) - allowing the stop. Digest:\n${digest}`;
      return {
        exitCode: 0,
        out: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: context } }),
        errText: '',
      };
    }
    writeBudget(REPO_NAME, blocks + 1);
    // The documented blocking path: exit 2, reason on stderr.
    return { exitCode: 2, out: '', errText: `[sm watch] the fleet needs attention before stopping:\n${digest}` };
  }
  // prompt-submit: added context, never a block; the budget is a Stop concern only.
  return {
    exitCode: 0,
    out: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[sm watch]\n${digest}` } }),
    errText: '',
  };
}

// --- desk seat: which session the hook path is allowed to speak from -------------------
// SM_DESK=1 is the launch-time marker. It only works if the desk was STARTED with it set,
// which silently yields an unwatched fleet when it was not - the failure this file's seat
// gate used to have no way to report. The marker file is the in-session equivalent: claim
// the seat from a session that is already running, and `sm floor` can then say who holds it.
// Liveness is the claimed pid, so a seat dies with its session instead of going stale.

const seatPath = repo => join(inboxStateDir(), `${repo || 'default'}.desk-seat.json`);

/**
 * The live desk-seat marker, or null (absent, corrupt, or the holder is dead - a seat whose
 * session exited must read as unclaimed so the next desk can take it without a manual sweep).
 * @param {string} [repo] - Repo name; defaults to the current repo.
 * @returns {{pid: number, startedAt: number}|null} the marker.
 */
export function readSeat(repo = REPO_NAME) {
  try {
    const doc = JSON.parse(readFileSync(seatPath(repo), 'utf8'));
    return pidIdentityLive({ pid: doc.pid, pidStart: null }) ? doc : null;
  }
  catch {
    return null;
  }
}

/**
 * Does this process speak for the desk? Either marker counts - the env var keeps every
 * existing SM_DESK=1 launcher working unchanged, and the file covers sessions that were
 * already running when someone decided they were the desk.
 * @param {string} [repo] - Repo name; defaults to the current repo.
 * @returns {boolean} whether the hook path may deliver.
 */
export function hasSeat(repo = REPO_NAME) {
  return process.env.SM_DESK === '1' || !!readSeat(repo);
}

function writeSeat(repo, pid) {
  mkdirSync(inboxStateDir(), { recursive: true });
  writeFileSync(seatPath(repo), `${JSON.stringify({ pid, startedAt: Date.now() })}\n`);
}

function clearSeat(repo) {
  rmSync(seatPath(repo), { force: true });
}

// --- armed marker: pidfile-style, in the inbox-state dir (never the watched inbox dir) ---

const armedPath = repo => join(inboxStateDir(), `${repo || 'default'}.watch-armed.json`);

/**
 * The live armed marker, or null (absent, corrupt, or the holder is dead - a kill -9'd
 * watch must read as NOT armed, so floor tells the truth).
 * @param {string} [repo] - Repo name; defaults to the current repo.
 * @returns {{pid: number, startedAt: number}|null} the marker.
 */
export function readArmed(repo = REPO_NAME) {
  try {
    const doc = JSON.parse(readFileSync(armedPath(repo), 'utf8'));
    return pidIdentityLive({ pid: doc.pid, pidStart: null }) ? doc : null;
  }
  catch {
    return null;
  }
}

function writeArmed(repo, mode = 'loop') {
  mkdirSync(inboxStateDir(), { recursive: true });
  writeFileSync(armedPath(repo), `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode })}\n`);
}

function clearArmed(repo) {
  rmSync(armedPath(repo), { force: true });
}

// Signal path: the finally in runWatchBlocking never runs on a signal, so clear here.
function clearArmedAndExit() {
  clearArmed(REPO_NAME);
  process.exit(0);
}

/**
 * The blocking human watch: arm the marker, wake on new reports (push) or on the snapshot
 * cadence (state events like crash have no report to wake on), digest via runCheck(ack).
 * Exported with a `world` seam so tests never touch a live mux.
 * @param {object} options - Loop options.
 * @param {boolean} [options.loop] - Keep going after the first digest.
 * @param {number} [options.timeoutMs] - Overall deadline; exit 3 if nothing ever surfaced.
 * @param {boolean} [options.json] - Machine output per digest.
 * @param {object|null} [options.world] - Injected world (tests).
 * @param {'loop'|'daemon'} [options.mode] - Stamped into the armed marker; daemon is the detached lifetime.
 * @returns {Promise<number>} the exit code (0 something surfaced, 3 nothing).
 */
export async function runWatchBlocking({ loop = false, timeoutMs = WATCH_TIMEOUT_MS, json = false, world = null, mode = 'loop' } = {}) {
  const deadline = Date.now() + timeoutMs;
  writeArmed(REPO_NAME, mode);
  let sawAny = false;
  try {
    // Set after a failed check so the retry skips the wait. Going back to
    // waitForReports would block on a NEW report, stranding the event the failed tick
    // was holding until something unrelated happened to arrive.
    let retryNow = false;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (!retryNow)
        await waitForReports(REPO_NAME, { timeoutMs: Math.max(1, Math.min(remaining, SNAPSHOT_POLL_SEC * 1000)) });
      retryNow = false;
      // One bad tick must not end the watch. A throw from runCheck (a gh hiccup, a mux
      // blip, an unreadable journal) used to escape this loop and stop supervision
      // silently - the worst failure shape available, since a dead watch and a quiet
      // fleet look identical from outside. Surface it and keep going.
      // THE SEAT IS THE BATON. A desk session holding the seat owns delivery through the
      // agent hooks; the daemon drops to a peek so the two never split events between
      // them (a consumed watermark fails SILENTLY - the reader that loses simply sees a
      // quiet fleet). readSeat, never hasSeat: hasSeat also honours SM_DESK=1 from the
      // CALLER's own env, which says nothing about whether a desk is sitting there.
      const deskSeated = !!readSeat(REPO_NAME);
      let exitCode;
      try {
        ({ exitCode } = await runCheck({ ack: !deskSeated, json, world }));
      }
      catch (err) {
        console.error(clr.red(`[sm watch] check failed, retrying: ${err.message}`));
        retryNow = true;
        await sleep(Math.min(WATCH_RETRY_MS, Math.max(1, deadline - Date.now())));
        continue;
      }
      if (exitCode === 0) {
        sawAny = true;
        if (!loop)
          break;
      }
    }
  }
  finally {
    clearArmed(REPO_NAME);
  }
  return sawAny ? 0 : 3;
}

// --- daemon lifecycle ------------------------------------------------------------------
// The loop was already a daemon in everything but lifetime: pid-checked marker, push wake,
// durable ack, bounded digest. This adds detach, a single-instance guard and a way to stop
// it. The log does NOT live in inboxDir() - subscribeReports/waitForReports fs.watch that
// directory, so every log line would wake every watcher in a tight feedback loop.
const daemonLogPath = repo => join(inboxStateDir(), `${repo || 'default'}.watch.log`);

// Version-stable spawn target, same rule serve uses: an import.meta.url sibling goes stale
// under the running daemon the moment a Homebrew upgrade moves the Cellar realpath.
function resolveWatchSpawnTarget() {
  const target = process.env.SM_WATCH_BIN || 'sm';
  const probe = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (probe.status !== 0)
    die(`watch: spawn target '${target}' failed the startup probe - is sm on PATH? (SM_WATCH_BIN overrides)`);
  return target;
}

function startDaemon() {
  const held = readArmed(REPO_NAME);
  if (held)
    die(`watch: already armed for ${REPO_NAME} by pid ${held.pid} (${held.mode ?? 'loop'}, started ${agoStr(held.startedAt)}) - stop it with sm watch --stop`);
  const target = resolveWatchSpawnTarget();
  mkdirSync(inboxStateDir(), { recursive: true });
  const log = openSync(daemonLogPath(REPO_NAME), 'a');
  const child = spawn(target, ['watch', '--loop', '--daemon-child', '--timeout', String(DAEMON_TIMEOUT_SEC)], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, SM_DESK: '' }, // a daemon is never a desk; never inherit the seat
  });
  child.unref();
  console.log(`sm watch daemon started for ${REPO_NAME} (pid ${child.pid})`);
  console.log(clr.dim(`  log: ${daemonLogPath(REPO_NAME)}`));
  console.log(clr.dim(`  stop: sm watch --stop`));
}

function daemonStatus(json) {
  const armed = readArmed(REPO_NAME);
  const seat = readSeat(REPO_NAME);
  if (json) {
    emitJson({ repo: REPO_NAME, armed, seat, log: daemonLogPath(REPO_NAME) });
    return;
  }
  if (!armed) {
    console.log(`watch: NOT armed for ${REPO_NAME}`);
  }
  else {
    console.log(`watch: armed for ${REPO_NAME} - ${armed.mode ?? 'loop'}, pid ${armed.pid}, started ${agoStr(armed.startedAt)}`);
    console.log(clr.dim(`  log: ${daemonLogPath(REPO_NAME)}`));
  }
  // The seat decides who ACKS, so status is a lie without it.
  console.log(seat
    ? `desk seat: held by pid ${seat.pid} (${agoStr(seat.startedAt)}) - the desk delivers, a daemon only peeks`
    : 'desk seat: unclaimed - a daemon would deliver');
}

function stopDaemon() {
  const armed = readArmed(REPO_NAME);
  if (!armed)
    die(`watch: nothing armed for ${REPO_NAME}`);
  try {
    process.kill(armed.pid, 'SIGTERM');
  }
  catch (err) {
    die(`watch: could not signal pid ${armed.pid}: ${err.message}`);
  }
  // The daemon clears its own marker in the finally; sweep it if the process was already
  // gone in a way pidIdentityLive could not see.
  rmSync(armedPath(REPO_NAME), { force: true });
  console.log(`sm watch daemon stopped for ${REPO_NAME} (pid ${armed.pid})`);
}

/**
 * watch: dispatcher supervision. `--check [--ack] [--json]` one-shot; bare/`--loop` blocks.
 * @param {string[]} argv - CLI arguments for the watch command.
 */
export async function cmdWatch(argv) {
  const { values } = parseCmd('watch', argv, argOptions('watch'));
  if (values.daemon) {
    startDaemon();
    return;
  }
  if (values.status) {
    daemonStatus(!!values.json);
    return;
  }
  if (values.stop) {
    stopDaemon();
    return;
  }
  if (values.unseat) {
    clearSeat(REPO_NAME);
    console.log(`desk seat released for ${REPO_NAME}`);
    return;
  }
  if (values.seat) {
    // Default to the parent: run from a session's own shell, that is the session. Pass
    // --pid when the caller sits further up (an agent harness spawning a throwaway shell
    // per command - there, $PPID from inside that shell is the session).
    const pid = values.pid != null ? Number(values.pid) : process.ppid;
    if (!Number.isInteger(pid) || pid <= 0)
      die(`watch: --pid must be a positive integer (got '${values.pid}')`);
    if (!pidIdentityLive({ pid, pidStart: null }))
      die(`watch: pid ${pid} is not running - seat not claimed`);
    const held = readSeat(REPO_NAME);
    if (held && held.pid !== pid)
      die(`watch: desk seat for ${REPO_NAME} is held by pid ${held.pid} (since ${agoStr(held.startedAt)}) - release it with sm watch --unseat`);
    writeSeat(REPO_NAME, pid);
    console.log(`desk seat claimed for ${REPO_NAME} by pid ${pid}`);
    return;
  }
  if (values.baseline) {
    // Draining a stale backlog through --ack costs one cycle per DIGEST_MAX events, and
    // through the Stop hook that is one BLOCKED STOP per cycle. --clear would work but is
    // destructive. Skipping forward is the third thing: watch stops looking back, the
    // reports stay readable via `sm msg inbox`.
    const entries = readInbox(REPO_NAME);
    if (!entries.length) {
      console.log('inbox is empty - nothing to baseline');
      return;
    }
    const newest = entries.at(-1).ts;
    advanceCursor(REPO_NAME, 'surfaced', newest);
    console.log(`baselined ${REPO_NAME} past ${entries.length} report(s) - read them with sm msg inbox --unread`);
    return;
  }
  if (values.hook) {
    if (!['stop', 'prompt-submit'].includes(values.hook))
      die(`watch: unknown --hook type '${values.hook}' (stop | prompt-submit)`);
    const { exitCode, out, errText } = await runHook({ type: values.hook });
    if (out)
      console.log(out);
    if (errText)
      console.error(errText);
    process.exitCode = exitCode;
    return;
  }
  if (values.ack && !values.check)
    die('watch: --ack requires --check');
  if (values.check) {
    const { exitCode } = await runCheck({ ack: !!values.ack, json: !!values.json });
    process.exitCode = exitCode;
    return;
  }
  const timeoutMs = values.timeout != null ? Math.max(1, Number(values.timeout)) * 1000 : WATCH_TIMEOUT_MS;
  const mode = values['daemon-child'] ? 'daemon' : 'loop';
  // A foreground loop must not clobber a live daemon's marker: two acking watchers split
  // events between them and the loser just sees a quiet fleet, which is silent by nature.
  const held = readArmed(REPO_NAME);
  if (held && held.mode === 'daemon' && mode !== 'daemon')
    die(`watch: a daemon is already armed for ${REPO_NAME} (pid ${held.pid}) - peek with sm watch --check, or stop it with sm watch --stop`);
  if (mode === 'daemon') {
    // The detached child owns the marker; honour SIGTERM so --stop is clean.
    for (const sig of ['SIGTERM', 'SIGINT'])
      process.on(sig, () => { clearArmedAndExit(); });
  }
  process.exitCode = await runWatchBlocking({ loop: !!values.loop, timeoutMs, json: !!values.json, mode });
}
