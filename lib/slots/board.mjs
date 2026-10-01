// The board: a non-interactive fleet display for the desk's second pane. PURE RENDER -
// every function here takes a plain model and returns strings, so the whole layout is
// unit-testable without a terminal. The IO (alt screen, repaint timer, the two gather
// cadences) lives in the caller.
//
// It answers the question a dispatcher actually keeps asking, which is not "what
// happened" but "what is stuck, and on whom". That is why NEEDS YOU is first and why
// the human-blocked PRs get their own section instead of being a column.
//
// It is READ-ONLY by construction: it renders a classify PEEK (never an ack), never
// advances the read cursor, never prunes a lock. A board that consumed events would
// silently starve the daemon and the hook path, and the failure would look like a quiet
// fleet rather than an error.
import { agoStr, clr, oneLine, pad } from '../format.mjs';

const RULE = width => clr.dim('─'.repeat(Math.max(10, width)));

/** Events that mean a human has to do something, newest intent first. */
const NEEDS_YOU = new Set(['needs-input', 'crash', 'needs-decision', 'blocked', 'failed', 'watch-degraded']);

/**
 * Split classify's surface into the board's two attention buckets.
 * @param {object[]} surface - classify() surface events (a peek, never acked).
 * @returns {{needsYou: object[], fyi: object[]}} partitioned events.
 */
export function partition(surface = []) {
  const needsYou = [];
  const fyi = [];
  for (const event of surface) {
    const key = event.type === 'report' ? event.verb : event.type;
    (NEEDS_YOU.has(key) ? needsYou : fyi).push(event);
  }
  return { needsYou, fyi };
}

/**
 * One line per attention event: slot, what kind, and the shortest useful detail.
 * @param {object} event - a classify surface event.
 * @param {number} width - terminal width.
 * @returns {string} the rendered line.
 */
export function attentionLine(event, width) {
  const kind = event.type === 'report' ? (event.verb ?? 'report') : event.type;
  const detail = event.message ?? event.reason ?? event.task ?? '';
  const slot = clr.bold(pad(event.slot ?? '-', 3));
  const room = Math.max(20, width - 26);
  return `  ${slot} ${clr.red(pad(kind, 13))} ${oneLine(detail, room)}`;
}

/**
 * The working section: claimed slots, what they hold, and how live they look.
 * @param {object[]} slots - floor snapshot slot rows.
 * @param {number} width - terminal width.
 * @param {number} [max] - rows before the rest are summarised.
 * @returns {string[]} rendered lines.
 */
export function workingLines(slots = [], width, max = 8) {
  const rows = slots.filter(row => row.locked);
  if (!rows.length)
    return [clr.dim('  nothing claimed')];
  // Order by what deserves the eye: a worker on a prompt, then live work, then the rest -
  // and within each, freshest claim first. A fleet accumulates stale locks, and a board
  // that lists them in slot order buries the one slot that actually needs something.
  const rank = (row) => {
    if (row.worker === 'live' && row.activity === 'waiting')
      return 0;
    if (row.worker === 'live' && row.activity === 'working')
      return 1;
    if (row.worker !== 'live')
      return 2;
    return 3;
  };
  const sorted = [...rows].sort((left, right) => rank(left) - rank(right) || (right.claimedAt ?? 0) - (left.claimedAt ?? 0));
  const shown = sorted.slice(0, max);
  const room = Math.max(16, width - 38);
  const lines = shown.map((row) => {
    const act = row.worker === 'live' ? row.activity : row.worker;
    const paint = row.activity === 'waiting' ? clr.red : row.worker !== 'live' ? clr.red : row.activity === 'working' ? clr.green : clr.dim;
    const age = row.claimedAt ? agoStr(row.claimedAt) : '-';
    return `  ${clr.bold(pad(row.slot, 3))} ${paint(pad(act, 9))} ${clr.dim(pad(age, 7))} ${oneLine(row.task ?? '-', room)}`;
  });
  if (sorted.length > shown.length)
    lines.push(clr.dim(`  +${sorted.length - shown.length} more claimed (idle)`));
  return lines;
}

/**
 * PRs that are green and waiting on a person - the fleet's real critical path, and the
 * thing a per-slot view hides: five slots each "fine" can still be one human's queue.
 * @param {object[]} prs - [{number, slot, reviewers, state}].
 * @param {number} width - terminal width.
 * @returns {string[]} rendered lines.
 */
export function humanBlockedLines(prs = [], width) {
  if (!prs.length)
    return [clr.dim('  none')];
  const byWho = new Map();
  for (const pr of prs) {
    const who = (pr.reviewers ?? []).join(',') || 'unassigned';
    if (!byWho.has(who))
      byWho.set(who, []);
    byWho.get(who).push(pr.number);
  }
  const room = Math.max(16, width - 24);
  return [...byWho].map(([who, nums]) =>
    `  ${clr.yellow(pad(`${nums.length} PR${nums.length === 1 ? '' : 's'}`, 7))} ${clr.bold(oneLine(who, 18))} ${clr.dim(oneLine(nums.map(num => `#${num}`).join(' '), room))}`);
}

/**
 * The whole frame. Pure: same model in, same lines out.
 * @param {object} model - {repo, slots, attention, prsBlocked, inbox, watch, seat, prsOk, stamp}.
 * @param {number} [width] - terminal width.
 * @returns {string[]} the frame, one string per line.
 */
export function renderBoard(model, width = 80) {
  const { repo, slots = [], attention = [], prsBlocked = [], inbox = {}, watch, seat, prsOk = true, stamp } = model;
  const { needsYou } = partition(attention);
  const claimed = slots.filter(row => row.locked).length;
  const live = slots.filter(row => row.worker === 'live').length;
  const lines = [];

  const head = `${clr.bold(repo ?? '-')}  ${clr.dim(`${slots.length} slots · ${live} live · ${claimed} claimed`)}`;
  lines.push(`${head}${stamp ? clr.dim(`   ${stamp}`) : ''}`);
  lines.push(RULE(width));

  lines.push(needsYou.length ? clr.red(clr.bold(`NEEDS YOU (${needsYou.length})`)) : clr.green(clr.bold('NEEDS YOU (0)')));
  lines.push(...(needsYou.length ? needsYou.map(event => attentionLine(event, width)) : [clr.dim('  nothing waiting on you')]));
  lines.push(RULE(width));

  lines.push(clr.bold(`WORKING (${claimed})`));
  lines.push(...workingLines(slots, width));
  lines.push(RULE(width));

  // prsOk false means the gh poll failed - say so rather than rendering "none", which
  // would read as "nothing is blocked" when it means "we do not know".
  lines.push(clr.bold('WAITING ON A HUMAN'));
  lines.push(...(prsOk ? humanBlockedLines(prsBlocked, width) : [clr.dim('  gh poll failed - unknown this tick')]));
  lines.push(RULE(width));

  const unread = inbox.unread ?? 0;
  const oldest = unread > 0 && inbox.oldestUnreadTs ? `, oldest ${agoStr(inbox.oldestUnreadTs)}` : '';
  const watchTxt = watch ? `${watch.mode ?? 'loop'} pid ${watch.pid}` : clr.red('NOT armed');
  const seatTxt = seat ? `held pid ${seat.pid}` : clr.red('unclaimed');
  lines.push(clr.dim(`inbox ${unread} unread${oldest}  ·  watch ${watchTxt}  ·  seat ${seatTxt}`));
  return lines;
}
