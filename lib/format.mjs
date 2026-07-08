// Output helpers: exit, JSON, color, spinner, and the human-facing renderers.
import { STATUS_COLOR } from './constants.mjs';

/**
 * Print a message to stderr and terminate the process with a failure status.
 * @param {string} msg - Message to print before exiting.
 */
export function die(msg) {
  console.error(msg);
  process.exit(1);
}
/**
 * Serialize a value as pretty-printed JSON on stdout.
 * @param {any} obj - Value to serialize.
 */
export const emitJson = obj => console.log(JSON.stringify(obj, null, 2));

// Color only on a TTY and when NO_COLOR is unset (so piped/worker output stays plain).
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\x1B[${code}m${text}\x1B[0m` : text);
/**
 * Color wrappers that emit ANSI escapes on a TTY and pass text through unchanged otherwise.
 * @type {Record<string, (text: string) => string>}
 */
export const clr = {
  green: text => paint('32', text),
  red: text => paint('31', text),
  yellow: text => paint('33', text),
  dim: text => paint('2', text),
  bold: text => paint('1', text),
};

/**
 * Right-pad a value's string form to a fixed width.
 * @param {any} str - Value to stringify and pad.
 * @param {number} width - Target column width.
 * @returns {string} The padded string.
 */
export const pad = (str, width) => String(str).padEnd(width);

/**
 * Collapse a possibly multi-line string to one line, ellipsized at max chars - for table
 * cells and one-line summaries (lock tasks and assistant messages contain newlines).
 * @param {string} str - Source string, possibly multi-line.
 * @param {number} max - Maximum length before the string is ellipsized.
 * @returns {string} The single-line, possibly truncated string.
 */
export function oneLine(str, max) {
  const line = String(str).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * A braille spinner; no-op when stdout is not a TTY. Returns a stop() that clears the line.
 * die() calls process.exit(), which skips finally blocks - so the cursor is restored on
 * process exit (and SIGINT) too, or an error mid-spin would leave the terminal cursorless.
 * @param {string} text - Label shown next to the spinner frames.
 * @returns {() => void} A function that stops the spinner and restores the cursor.
 */
export function startSpinner(text) {
  if (!process.stdout.isTTY)
    return () => {};
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let idx = 0;
  process.stdout.write('\x1B[?25l'); // hide cursor
  const iv = setInterval(
    () => process.stdout.write(`\r${frames[(idx = (idx + 1) % frames.length)]} ${text}`),
    80,
  );
  const restore = () => {
    clearInterval(iv);
    process.stdout.write('\r\x1B[K\x1B[?25h'); // clear line, restore cursor
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

/**
 * Format an elapsed-seconds count as a compact "Xs/Xm/Xh" string.
 * @param {number} seconds - Elapsed time in seconds.
 * @returns {string} Compact human-readable duration.
 */
export function fmtAge(seconds) {
  return seconds < 90 ? `${seconds}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
}

/**
 * "Xs/Xm/Xh ago" from an epoch-ms timestamp - the one spelling of age everywhere.
 * @param {number} ts - Epoch-milliseconds timestamp.
 * @returns {string} Age string ending in " ago".
 */
export const agoStr = ts => `${fmtAge(Math.floor((Date.now() - (ts || Date.now())) / 1000))} ago`;

/**
 * Render session rows ({ name, windows, slots, attached }) as an aligned list, for
 * `ls` and for the "which one?" hint when `msg` finds several sessions.
 * @param {Array<{name: string, windows: number, slots: number, attached: boolean}>} rows - Session rows to render.
 * @param {string} sessionPrefix - Prefix used in the empty-state message.
 * @returns {string} The formatted, newline-joined list.
 */
export function formatSessions(rows, sessionPrefix) {
  if (!rows.length)
    return `no running ${sessionPrefix ? `${sessionPrefix}* ` : ''}sessions`;
  const width = Math.max(...rows.map(row => row.name.length));
  return rows
    .map(
      row =>
        `  ${row.name.padEnd(width)}  ${row.windows} win, ${row.slots} slot${row.slots === 1 ? '' : 's'}${row.attached ? ', attached' : ''}`,
    )
    .join('\n');
}

/**
 * Render a slot's PRs for the `slot ls` pr column: each as "#<number> <state>" (state lowercased),
 * so a merged PR is visible even on a locked slot - a bare number would hide it. '-' when none.
 * @param {Array<{number: number, state: string}>} prs - The branch's PRs.
 * @returns {string} The pr-column cell text.
 */
export function prCell(prs) {
  return prs.map(pr => `#${pr.number} ${(pr.state || '?').toLowerCase()}`).join(', ') || '-';
}

/**
 * Render the free table. A `worker` column appears only when some slot's Claude has died.
 * @param {Array<object>} rows - Slot rows to render as table lines.
 */
export function renderFree(rows) {
  const prText = row => prCell(row.prs); // branch's PR(s) with state, so merged is visible
  const issueText = row => row.issue || '-'; // tracker id; the lockfile is its source of truth
  const showWorker = rows.some(row => row.worker === 'dead');
  const lw = Math.max(4, ...rows.map(row => row.slot.length));
  const sw = Math.max(6, ...rows.map(row => row.status.length));
  const pw = Math.max(2, ...rows.map(row => prText(row).length));
  const iw = Math.max(5, ...rows.map(row => issueText(row).length));
  const head = showWorker
    ? `${pad('slot', lw)} ${pad('status', sw)} ${pad('worker', 6)} ${pad('issue', iw)} ${pad('pr', pw)} branch`
    : `${pad('slot', lw)} ${pad('status', sw)} ${pad('issue', iw)} ${pad('pr', pw)} branch`;
  console.log(clr.dim(head));
  for (const row of rows) {
    const status = (clr[STATUS_COLOR[row.status]] || clr.dim)(pad(row.status, sw));
    const workerColor = row.worker === 'live' ? clr.green : row.worker === 'dead' ? clr.red : clr.dim;
    const workerCell = showWorker ? `${workerColor(pad(row.worker, 6))} ` : '';
    console.log(
      `${clr.bold(pad(row.slot, lw))} ${status} ${workerCell}${pad(issueText(row), iw)} ${pad(prText(row), pw)} ${row.branch}`,
    );
  }
}
