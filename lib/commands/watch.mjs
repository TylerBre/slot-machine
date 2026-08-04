// sm watch: the supervision core. Gather evidence (IO), classify (pure - lib/slots/verbs.mjs),
// emit a digest. The one-shot `--check` path is the primitive every delivery surface calls
// (hooks, a future UI, a human's alias); the blocking mode is a thin loop over it. The watch
// is a PURE OBSERVER: it never types into panes, claims nothing, consumes nothing - its only
// writes are the surfaced watermark, journal facts, and its own armed marker.
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  CRASH_RESAMPLE_MS,
  DIGEST_MAX,
  DOCS,
  HOOK_BLOCK_BUDGET,
  PREFIX,
  REPO_DIR,
  REPO_NAME,
  SNAPSHOT_POLL_SEC,
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
 * crash resample), activity, and the checked PR map. Inbox/journal/cursor state is read
 * in runCheck (it rides the env seams and stays hermetic in tests; this part is the live
 * world and is injectable via runCheck's `world` option).
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
  // In-run crash debounce: a second sample CRASH_RESAMPLE_MS later, taken ONLY when the
  // first shows a claimed slot down (the happy path pays nothing). classify needs both
  // samples to agree before it calls anything a crash.
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
const TAG_COLOR = { 'done': clr.green, 'blocked': clr.red, 'needs-decision': clr.red, 'failed': clr.red, 'crash': clr.red, 'pr-merged': clr.green };
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
 * world, classify, cap the digest, ack durably when asked, print. Ack order per spec:
 * durable record (journal facts, watermark) BEFORE the signal (stdout); a failed write
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
        if (event.type === 'stale-paused' || event.type === 'stalled-working')
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
// settings; this is the command those hooks run. Protocol facts verified against the
// Claude Code hooks docs (2026-08): blocking = exit 2 + reason on stderr (stdout ignored);
// context = exit 0 + {hookSpecificOutput: {hookEventName, additionalContext}}; exit 0 with
// no output = documented no-action. Loop prevention is OUR budget counter - the docs list
// no stop_hook_active field.

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
  // SEAT GATE - the --hook path ONLY (bare --check/--ack never consult SM_DESK; a peek is
  // always safe from any seat). Every session in the desk project runs the installed hook,
  // including extra desk agents and possibly workers; only the session launched with
  // SM_DESK=1 is the delivery seat. Env inheritance into hook subprocesses is undocumented
  // (verified empirically at install time); the gate fails CLOSED - no marker, no ack, no
  // output, exit 0 (documented: no output = no action). Seat-marker refinement candidates,
  // logged not built: a config-registered desk session id; a desk marker file; pane-title
  // introspection.
  if (process.env.SM_DESK !== '1')
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
      // Degraded-allow: a broken check (or a fleet that stays noisy) must never wedge the
      // session. Speak as context and let the stop happen; only a clean pass resets.
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

function writeArmed(repo) {
  mkdirSync(inboxStateDir(), { recursive: true });
  writeFileSync(armedPath(repo), `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
}

function clearArmed(repo) {
  rmSync(armedPath(repo), { force: true });
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
 * @returns {Promise<number>} the exit code (0 something surfaced, 3 nothing).
 */
export async function runWatchBlocking({ loop = false, timeoutMs = WATCH_TIMEOUT_MS, json = false, world = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  writeArmed(REPO_NAME);
  let sawAny = false;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await waitForReports(REPO_NAME, { timeoutMs: Math.max(1, Math.min(remaining, SNAPSHOT_POLL_SEC * 1000)) });
      const { exitCode } = await runCheck({ ack: true, json, world });
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

/**
 * watch: dispatcher supervision. `--check [--ack] [--json]` one-shot; bare/`--loop` blocks.
 * @param {string[]} argv - CLI arguments for the watch command.
 */
export async function cmdWatch(argv) {
  const { values } = parseCmd('watch', argv, argOptions('watch'));
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
  process.exitCode = await runWatchBlocking({ loop: !!values.loop, timeoutMs, json: !!values.json });
}
