// Output helpers: exit, JSON, color, spinner, and the human-facing renderers.
import { STATUS_COLOR } from './constants.mjs';

export const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
export const emitJson = (obj) => console.log(JSON.stringify(obj, null, 2));

// Color only on a TTY and when NO_COLOR is unset (so piped/worker output stays plain).
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
export const clr = {
  green: (s) => paint('32', s),
  red: (s) => paint('31', s),
  yellow: (s) => paint('33', s),
  dim: (s) => paint('2', s),
  bold: (s) => paint('1', s),
};

export const pad = (s, n) => String(s).padEnd(n);

// Collapse a possibly multi-line string to one line, ellipsized at max chars - for table
// cells and one-line summaries (lock tasks and assistant messages contain newlines).
export function oneLine(s, max) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

// A braille spinner; no-op when stdout is not a TTY. Returns a stop() that clears the line.
// die() calls process.exit(), which skips finally blocks - so the cursor is restored on
// process exit (and SIGINT) too, or an error mid-spin would leave the terminal cursorless.
export function startSpinner(text) {
  if (!process.stdout.isTTY) return () => {};
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  process.stdout.write('\x1b[?25l'); // hide cursor
  const iv = setInterval(
    () => process.stdout.write(`\r${frames[(i = (i + 1) % frames.length)]} ${text}`),
    80,
  );
  const restore = () => {
    clearInterval(iv);
    process.stdout.write('\r\x1b[K\x1b[?25h'); // clear line, restore cursor
  };
  const onSigint = () => {
    restore();
    process.exit(130);
  };
  process.once('exit', restore);
  process.once('SIGINT', onSigint);
  return () => {
    process.removeListener('exit', restore);
    process.removeListener('SIGINT', onSigint);
    restore();
  };
}

export const fmtAge = (s) =>
  s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;

// "Xs/Xm/Xh ago" from an epoch-ms timestamp - the one spelling of age everywhere.
export const agoStr = (ts) => `${fmtAge(Math.floor((Date.now() - (ts || Date.now())) / 1000))} ago`;

// Render session rows ({ name, windows, slots, attached }) as an aligned list, for
// `ls` and for the "which one?" hint when `msg` finds several sessions.
export function formatSessions(rows, sessionPrefix) {
  if (!rows.length) return `no running ${sessionPrefix ? `${sessionPrefix}* ` : ''}sessions`;
  const w = Math.max(...rows.map((r) => r.name.length));
  return rows
    .map(
      (r) =>
        `  ${r.name.padEnd(w)}  ${r.windows} win, ${r.slots} slot${r.slots === 1 ? '' : 's'}${r.attached ? ', attached' : ''}`,
    )
    .join('\n');
}

// Render the free table. A `worker` column appears only when some slot's Claude has died.
export function renderFree(rows) {
  const prText = (r) => r.prs.map((p) => '#' + p.number).join(',') || '-'; // branch's PR(s), any state
  const showWorker = rows.some((r) => r.worker === 'dead');
  const lw = Math.max(4, ...rows.map((r) => r.slot.length));
  const sw = Math.max(6, ...rows.map((r) => r.status.length));
  const pw = Math.max(2, ...rows.map((r) => prText(r).length));
  const head = showWorker
    ? `${pad('slot', lw)} ${pad('status', sw)} ${pad('worker', 6)} ${pad('pr', pw)} branch`
    : `${pad('slot', lw)} ${pad('status', sw)} ${pad('pr', pw)} branch`;
  console.log(clr.dim(head));
  for (const r of rows) {
    const status = (clr[STATUS_COLOR[r.status]] || clr.dim)(pad(r.status, sw));
    const workerColor = r.worker === 'live' ? clr.green : r.worker === 'dead' ? clr.red : clr.dim;
    const workerCell = showWorker ? `${workerColor(pad(r.worker, 6))} ` : '';
    console.log(`${clr.bold(pad(r.slot, lw))} ${status} ${workerCell}${pad(prText(r), pw)} ${r.branch}`);
  }
}
