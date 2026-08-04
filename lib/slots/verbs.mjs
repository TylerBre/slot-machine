// Report verbs: the worker->dispatcher triage vocabulary. A report leads with
// "<verb>:" so supervision can tell "needs me" from "just telling me". Verbs are
// parsed at READ time and never persisted - the inbox record schema stays unbumped,
// so a version-skewed reader (this machine runs two MCP registrations resolving two
// binaries) can never drop new reports as malformed. The parse rule can tighten or
// loosen without stranding frozen stamps in the data.

import { GH_FAIL_SURFACE_AFTER, PAUSED_RESURFACE_MIN, STALLED_WORKING_MIN } from '../constants.mjs';

/** The verbs a report may lead with; anything else parses null. */
export const VERBS = ['done', 'blocked', 'needs-decision', 'failed', 'working', 'paused'];

const VERB_RE = /^(done|blocked|needs-decision|failed|working|paused)\s*:/i;

/**
 * The triage verb of a report message, or null when it declares none (unknown demands
 * attention - null SURFACES, failing toward waking the dispatcher). Pure and total:
 * any input, never throws.
 * @param {string} message - The report text.
 * @returns {'done'|'blocked'|'needs-decision'|'failed'|'working'|'paused'|null} the verb.
 */
export function parseVerb(message) {
  const match = typeof message === 'string' ? VERB_RE.exec(message) : null;
  return match ? match[1].toLowerCase() : null;
}

/** Verbs that end a task's story: a worker that said one of these then exited did not crash. */
export const TERMINAL_VERBS = ['done', 'blocked', 'needs-decision', 'failed'];

const minMs = minutes => minutes * 60_000;

/**
 * The absorb/surface policy - PURE. Every input is a plain value (the gatherer does IO;
 * this decides); same evidence in, same classification out, whether the caller ran for
 * hours or was born one millisecond ago. Every predicate reads durable state at one
 * instant - the only cross-run memory is the journal facts and the surfaced watermark
 * passed IN.
 *
 * @param {object} evidence - Plain-value world snapshot.
 * @param {object[]} [evidence.entries] - ALL inbox entries, any order (each {ts, slot, message}).
 * @param {number} [evidence.surfacedTs] - The surfaced watermark; only newer entries are "new".
 * @param {object[]} [evidence.slots] - Fleet claims: [{slot, claim: {ts, task}|null}].
 * @param {object} [evidence.workersA] - First worker sample: slot -> 'live'|'dead'|'none' (missing = none).
 * @param {object|null} [evidence.workersB] - In-run resample (CRASH_RESAMPLE_MS later); null = not taken.
 * @param {object} [evidence.activity] - Instantaneous activity sample: slot -> activity token.
 * @param {boolean} [evidence.snapshotOk] - Mux envelope ok; false suppresses every pane-based verdict.
 * @param {{ok: boolean, bySlot: object}} [evidence.prs] - Checked PR map; ok:false omits pr events.
 * @param {object[]} [evidence.journal] - Journal tail (surfaced + pr-merged facts = the dedup memory).
 * @param {number} [evidence.ghFails] - Consecutive gh failures (loop mode's liveness counter).
 * @param {number} evidence.now - The clock, epoch ms. Required - classify never reads one.
 * @param {object} [overrides] - Threshold overrides for tests: {pausedMin, stalledMin, ghFailAfter}.
 * @returns {{surface: object[], absorbed: object[]}} events demanding attention / events absorbed with reasons.
 */
export function classify(evidence, overrides = {}) {
  const {
    entries = [],
    surfacedTs = 0,
    slots = [],
    workersA = {},
    workersB = null,
    activity = {},
    snapshotOk = true,
    prs = { ok: false, bySlot: {} },
    journal = [],
    ghFails = 0,
    now,
  } = evidence;
  if (typeof now !== 'number')
    throw new Error('classify: now (epoch ms) is required evidence');
  const th = { pausedMin: PAUSED_RESURFACE_MIN, stalledMin: STALLED_WORKING_MIN, ghFailAfter: GH_FAIL_SURFACE_AFTER, ...overrides };
  const surface = [];
  const absorbed = [];
  const ordered = [...entries].sort((left, right) => left.ts - right.ts);

  // 1. New reports (above the watermark), oldest first: attention verbs and null SURFACE
  // (unknown demands attention); working/paused are progress notes - absorbed here and
  // aged by the state predicates below, per their windows rather than per report.
  for (const record of ordered) {
    if (record.ts <= surfacedTs)
      continue;
    const verb = parseVerb(record.message);
    if (verb === 'working' || verb === 'paused')
      absorbed.push({ type: 'report', slot: record.slot, ts: record.ts, verb, reason: `${verb} note - aged by its window` });
    else
      surface.push({ type: 'report', slot: record.slot, ts: record.ts, verb, message: record.message });
  }

  // The durable dedup memory: surfaced facts (windowed) + pr-merged facts (permanent).
  // Duplicate facts read as one (the benign check-then-append race is tolerated here).
  const facts = journal.filter(record => record.type === 'surfaced');
  const lastFact = (slot, reason) =>
    Math.max(0, ...facts.filter(record => record.slot === slot && record.reason === reason).map(record => record.ts));

  // Newest report per slot, watermark-INdependent: these predicates age the report
  // itself, so an already-read paused: still re-surfaces when its window lapses.
  const newest = new Map();
  for (const record of ordered) {
    if (record.slot)
      newest.set(record.slot, record);
  }

  // 2. stale-paused / stalled-working
  for (const [slot, record] of newest) {
    const verb = parseVerb(record.message);
    const age = now - record.ts;
    if (verb === 'paused') {
      if (age <= minMs(th.pausedMin))
        absorbed.push({ type: 'stale-paused', slot, reason: 'pause holds within its window' });
      else if (now - lastFact(slot, 'stale-paused') <= minMs(th.pausedMin))
        absorbed.push({ type: 'stale-paused', slot, reason: 'already surfaced within the window' });
      else
        surface.push({ type: 'stale-paused', slot, reportTs: record.ts, reason: record.message });
    }
    else if (verb === 'working' && snapshotOk && age > minMs(th.stalledMin)) {
      if (activity[slot] === 'working')
        absorbed.push({ type: 'stalled-working', slot, reason: 'activity shows live work' });
      else if (now - lastFact(slot, 'stalled-working') <= minMs(th.stalledMin))
        absorbed.push({ type: 'stalled-working', slot, reason: 'already surfaced within the window' });
      else
        surface.push({ type: 'stalled-working', slot, reportTs: record.ts, activity: activity[slot] ?? 'unknown' });
    }
  }

  // 3. crash: claim + worker down in BOTH samples + no terminal report since the claim.
  // A failed snapshot fires nothing - a transient mux error must never fabricate alarms.
  const downIn = (sample, slot) => ['dead', 'none'].includes(sample?.[slot] ?? 'none');
  if (snapshotOk) {
    for (const { slot, claim } of slots) {
      if (!claim || !downIn(workersA, slot))
        continue;
      if (workersB == null) {
        absorbed.push({ type: 'crash', slot, reason: 'single sample - absence not debounced' });
        continue;
      }
      if (!downIn(workersB, slot)) {
        absorbed.push({ type: 'crash', slot, reason: 'second sample shows the worker back' });
        continue;
      }
      const finished = ordered.some(record =>
        record.slot === slot && record.ts >= claim.ts && TERMINAL_VERBS.includes(parseVerb(record.message)));
      if (finished) {
        absorbed.push({ type: 'crash', slot, reason: 'terminal report since the claim - finished, not crashed' });
        continue;
      }
      if (facts.some(record => record.slot === slot && record.reason === 'crash' && record.claimTs === claim.ts))
        continue; // permanently deduped for THIS claim; a re-claim gets a fresh key
      surface.push({ type: 'crash', slot, claimTs: claim.ts, task: claim.task ?? null });
    }
  }

  // 4. pr-merged: state-based, so a merge landing between runs surfaces on the next
  // run's first look. ok:false omits pr events entirely - never guess from a stale map.
  if (prs.ok) {
    for (const { slot, claim } of slots) {
      if (!claim)
        continue;
      for (const pr of prs.bySlot?.[slot] ?? []) {
        if (pr.state !== 'MERGED')
          continue;
        if (journal.some(record => record.type === 'pr-merged' && record.slot === slot && record.pr === pr.number))
          continue;
        surface.push({ type: 'pr-merged', slot, pr: pr.number });
      }
    }
  }

  // 5. watch-degraded: loop mode's liveness aid (the counter is the caller's, passed in).
  if (ghFails >= th.ghFailAfter)
    surface.push({ type: 'watch-degraded', reason: `gh polling failed ${ghFails} consecutive times` });

  return { surface, absorbed };
}
