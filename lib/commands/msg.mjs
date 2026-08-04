// msg namespace: dispatch task lines to slot panes, worker reports, and the dispatcher inbox.
import { join } from 'node:path';
import {
  DOCS,
  PREFIX,
  REPO_DIR,
  REPO_NAME,
  UNTIL_IDLE_POLL_MS,
  UNTIL_IDLE_TIMEOUT_MS,
} from '../constants.mjs';
import {
  agoStr,
  clr,
  die,
  emitJson,
  oneLine,
} from '../format.mjs';
import { listSlots } from '../exec.mjs';
import { muxReq, resubmitMessage, sendMessage } from '../mux/index.mjs';
import {
  detectRole,
  pickDispatchSlot,
  resolveSlots,
  selectPanes,
} from '../slots/pure.mjs';
import { readLock, writeLock } from '../slots/locks.mjs';
import { slotWorkerMap } from '../slots/gather.mjs';
import { loadRoster, resolveInstance } from '../agents/index.mjs';
import { advanceCursor, appendReport, clearInbox, consumeReports, lastEntryTs, readCursor, readInbox, shapeInbox, waitForReports } from '../inbox.mjs';
import { argOptions, freenessRows, journalDispatch, parseCmd, recordWorker, resolveSession } from './shared.mjs';
import { resetSlot, slotWorkLanded } from './slot.mjs';

/**
 * report "<message>": a slot worker's back-channel to the dispatcher. Detects its own slot from
 * cwd and appends the message to the repo inbox, which the dispatcher reads via `sm msg inbox`.
 * @param {string[]} argv - CLI arguments for the report command.
 */
export function cmdReport(argv) {
  const { values, positionals } = parseCmd('report', argv, argOptions('msg-report'));
  if (!positionals.length)
    die('report: a message is required, e.g. sm msg report "done: PR #123, 96%"');
  if (positionals.length > 1)
    die(`report: unexpected extra argument '${positionals[1]}' - quote the message`);
  const slot = values.slot || detectRole(process.cwd(), DOCS, PREFIX).slot || null;
  appendReport(REPO_NAME, { slot, message: positionals[0] });
  if (values.json) {
    emitJson({ reported: true, slot, repo: REPO_NAME });
    return;
  }
  console.log(`reported to dispatcher${slot ? ` as slot ${slot}` : ''}`);
}

/**
 * inbox: the dispatcher reads worker reports. --clear consumes them; --watch tails and exits on
 * the first new report (for background re-invoke); --json for machine output.
 * @param {string[]} argv - CLI arguments for the inbox command.
 */
export async function cmdInbox(argv) {
  const { values } = parseCmd('inbox', argv, argOptions('msg-inbox'));
  if (values.unread) {
    if (values.clear || values.watch)
      die('inbox: --unread does not combine with --clear or --watch');
    // Non-destructive read: show entries past the read cursor, then advance it to the
    // newest DISPLAYED entry. Entries stay in the inbox; only the cursor moves.
    const fresh = readInbox(REPO_NAME, { sinceTs: readCursor(REPO_NAME, 'read') });
    const shaped = shapeInbox(fresh, { number: values.number, newestFirst: values['newest-first'] });
    printInbox(shaped, values.json);
    if (shaped.length)
      advanceCursor(REPO_NAME, 'read', Math.max(...shaped.map(entry => entry.ts)));
    return;
  }
  if (values.watch) {
    // Subscribe, don't poll: fs events wake us the moment a report lands (see waitForReports).
    // ts-anchored, not length-anchored: a concurrent --clear cannot blind the wake.
    const baselineTs = lastEntryTs(REPO_NAME);
    const fresh = await waitForReports(REPO_NAME, { baselineTs });
    if (fresh.length) {
      printInbox(fresh, values.json);
      // Consume exactly the reports we displayed (by their unique ts) - not the whole inbox,
      // which would drop reports that predate the watch or arrived during the print.
      if (values.clear)
        consumeReports(REPO_NAME, fresh.map(entry => entry.ts));
      return;
    }
    if (values.json)
      emitJson([]);
    else console.log('inbox: no new reports (watch timed out)');
    return;
  }
  const shaped = shapeInbox(readInbox(REPO_NAME), { number: values.number, newestFirst: values['newest-first'] });
  printInbox(shaped, values.json);
  if (values.clear)
    clearInbox(REPO_NAME);
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
  for (const entry of entries) {
    const age = entry.ts ? agoStr(entry.ts) : '';
    console.log(`${clr.bold(entry.slot || '-')}  ${clr.dim(age)}  ${entry.message}`);
  }
}

// Send one submitted line to the LIVE slot panes matching `want` (null = all). A pane whose worker
// is not live (Claude exited, pane back at a bare shell) is NOT typed into - doing so would run the
// task text as a shell command - it is marked .dead so the caller warns and never claims it. Live
// targets get a verified-submit .submitted flag so the caller reports delivery honestly.
function sendToPanes(session, want, msg, liveWorkers) {
  const targets = selectPanes(muxReq('listPanes', { scope: { session } }), DOCS, PREFIX, want);
  for (const target of targets) {
    if (liveWorkers.get(target.lbl) !== 'live') {
      target.dead = true; // Claude not running here - skip, don't type into a shell
      target.submitted = false;
      continue;
    }
    target.submitted = sendMessage(target.id, msg);
  }
  return targets;
}

// --until-idle: any target that typed but never submitted (worker busy, or the TUI was still
// ingesting the paste when the Enter arrived) still has its text sitting in the composer. Re-submit
// those - never re-type, which would duplicate the pending text - on an interval until every
// target's composer accepts the submit, or the timeout. Mutates each target's .submitted in place.
async function retryUntilIdle(targets) {
  const deadline = Date.now() + UNTIL_IDLE_TIMEOUT_MS;
  let pending = targets.filter(target => !target.submitted);
  while (pending.length && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, UNTIL_IDLE_POLL_MS));
    for (const target of pending) target.submitted = resubmitMessage(target.id);
    pending = targets.filter(target => !target.submitted);
  }
}

// Pick the first reusable slot with a live worker, resetting a merged one to a clean base, then
// CLAIM it immediately (write its lock) so a racing `worker run`/`msg -f` sees it busy and picks a
// different slot - closing the select-then-deliver TOCTOU that otherwise double-books one slot.
async function pickReusable(json, who, session, msg) {
  const rows = await freenessRows(json, 'finding a free slot...');
  const pick = pickDispatchSlot(rows);
  if (!pick)
    die(`${who}: no free slot with a live worker (see: sm slot ls)`);
  let reset = false;
  if (pick.status === 'merged') {
    // Landed-work proof before the destructive force-reset: "merged" means every PR on the
    // branch is merged, NOT that every local commit is in one - a straggler committed after
    // the merge would be silently destroyed. Refuse and point at the slot instead.
    if (!(await slotWorkLanded(join(DOCS, PREFIX + pick.slot), pick.branch, pick.prs)))
      die(`${who}: slot ${pick.slot} classified merged, but its HEAD is not contained in its remote branch or any merged PR - it may have unlanded commits; inspect it: sm slot inspect ${pick.slot}`);
    try {
      // force: this slot classified 'merged' (all its PRs are merged), so its branch commits are
      // already in the base via squash-merge - reset's unmerged-commit guard would otherwise refuse
      // (squash-merged commits are not ancestors of origin/base) and block reclaiming the slot.
      await resetSlot(PREFIX + pick.slot, { force: true });
      reset = true;
    }
    catch (err) {
      die(`${who}: could not reset slot ${pick.slot} - ${err.message}`);
    }
  }
  writeLock(join(DOCS, PREFIX + pick.slot), { session, task: oneLine(msg, 140) }); // claim-at-select
  return { slot: pick.slot, from: pick.status, reset };
}

/**
 * msg: submit a task line to one, some, or all slot panes and claim each freshly-tasked slot.
 * @param {string[]} argv - CLI arguments for the message command.
 * @param {string} who - Command name used in help and error text.
 */
export async function cmdMsg(argv, who = 'send') {
  const { values, positionals } = parseCmd(who, argv, argOptions('msg-send'));
  if (positionals.length < 1)
    die(`${who}: a message argument is required (try --help)`);
  if (positionals.length > 1)
    die(`${who}: unexpected extra argument '${positionals[1]}' (did you mean -t ${positionals[1]}?)`);
  if (values['first-free'] && values.slots != null)
    die(`${who}: use either --first-free or --slots, not both`);
  const msg = positionals[0];

  const labels = listSlots().map(name => name.slice(PREFIX.length));
  if (labels.length === 0)
    die(`${who}: no ${PREFIX}* worktrees in ${DOCS} - create one: sm slot create a`);

  const sess = resolveSession(values.session, who);

  let want = null; // null => all slots
  let picked = null; // set when --first-free chose a slot
  if (values['first-free']) {
    picked = await pickReusable(values.json, who, sess, msg);
    want = new Set([picked.slot]);
  }
  else if (values.slots != null) {
    try {
      want = resolveSlots(values.slots, labels);
    }
    catch (err) {
      die(`${who}: ${err.message}`);
    }
  }

  const liveWorkers = slotWorkerMap(); // one snapshot: gate delivery AND the claim below
  const text
    = values.brief && want && want.size === 1
      ? `You are the worker for slot ${[...want][0]} in the slot-machine model - run 'sm worker role' for how to operate here, then do this task: ${msg}`
      : msg;
  const targets = sendToPanes(sess, want, text, liveWorkers);
  if (values['until-idle'])
    await retryUntilIdle(targets);
  // slot-machine owns the lock: claim each freshly-tasked slot. Skip slash-commands (control
  // messages like /clear, not task dispatch - they claim nothing and journal nothing).
  if (!msg.startsWith('/')) {
    const submitted = targets.filter(entry => entry.submitted);
    if (submitted.length)
      await loadRoster(); // resolve each slot's agent instance for the worker record
    // Only claim slots whose composer verifiably submitted - a typed-but-unsent task must
    // not lock a slot with work no worker actually started.
    for (const target of submitted) {
      const tdir = join(DOCS, PREFIX + target.lbl);
      const held = readLock(tdir) && liveWorkers.get(target.lbl) === 'live';
      // Fresh claim when the slot is unheld/dead; on a TARGETED re-dispatch (-s/-f) to a slot
      // already held by a live worker, refresh the recorded task so ps/inspect track the latest
      // work. A broadcast (want == null) leaves an existing lock's task label untouched.
      if (!held || want != null)
        writeLock(tdir, { session: sess, task: oneLine(msg, 140) });
      // The worker record + the delivery fact, AFTER the claim write and BEFORE the CLI
      // reports (post-verification journaling; see the persistence spec's write ordering).
      try {
        const { name, model } = resolveInstance(REPO_DIR, target.lbl);
        recordWorker(tdir, target.lbl, { agent: name, model, transport: 'pane' });
      }
      catch { /* unresolved instance: nothing to record; delivery already happened */ }
      journalDispatch(target.lbl, oneLine(msg, 140));
    }
  }
  const sent = targets.filter(target => target.submitted).map(target => target.lbl);
  const unsubmitted = targets.filter(target => !target.submitted && !target.dead).map(target => target.lbl);
  const dead = targets.filter(target => target.dead).map(target => target.lbl);
  const live = targets.length - dead.length;
  const missing = want ? [...want].filter(label => !targets.some(target => target.lbl === label)) : [];
  if (!sent.length)
    process.exitCode = 1; // a dispatch that delivered nothing is not success
  if (values.json) {
    emitJson({
      session: sess,
      sent,
      unsubmitted,
      dead,
      missing,
      ...(picked ? { picked: picked.slot, from: picked.from, reset: picked.reset } : {}),
    });
    return;
  }
  if (missing.length)
    console.error(`${who}: warning - no running pane for slot(s): ${missing.join(' ')}`);
  if (dead.length) {
    console.error(
      `${who}: warning - worker not live (agent exited to a shell); skipped, NOT delivered: ${dead.join(' ')}`,
    );
  }
  if (unsubmitted.length) {
    console.error(
      `${who}: warning - typed but did NOT submit (composer never cleared): ${unsubmitted.join(' ')} - re-run`,
    );
  }
  console.log(
    `delivered to ${sent.length}/${live} live slot pane(s) in '${sess}'${picked ? ` (first-free: ${clr.bold(picked.slot)}${picked.reset ? ', reset from merged' : ''})` : ''}`,
  );
}
