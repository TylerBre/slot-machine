// The multiplexer registry + the core IO helpers built on backend primitives. The active
// backend comes from settings.mux (default tmux); backends are built-in only. All ops
// dispatch through the guarded call path, so a backend gap is an envelope, never a crash.
import { loadConfig } from '../context.mjs';
import { die } from '../format.mjs';
import { callOp } from './contract.mjs';
import tmux from './tmux.mjs';
import zellij from './zellij.mjs';

export const BUILTINS = { tmux, zellij };

let active = null;

/**
 * The active multiplexer backend, resolved once per process from settings.mux (default tmux).
 * @returns {object} the active backend plugin.
 */
export function activeMux() {
  if (active)
    return active;
  const name = loadConfig().settings?.mux ?? 'tmux';
  const plugin = BUILTINS[name];
  if (!plugin)
    die(`unknown multiplexer '${name}' in settings.mux (known: ${Object.keys(BUILTINS).join(', ')})`);
  active = plugin;
  return active;
}

/** Clear the memoized backend (test-only). */
export function resetMuxForTest() {
  active = null;
}

/**
 * Call an op on the active backend through the guarded path; returns the envelope.
 * @param {string} op - the op name.
 * @param {object} [args] - the op arguments.
 * @returns {{ok: boolean, value?: *, err?: string, detail?: string}} the envelope.
 */
export function mux(op, args = {}) {
  return callOp(activeMux(), op, args);
}

/**
 * Call an op and unwrap it, dying with context on failure - for callers where a backend
 * failure is fatal (the old `req()` behavior).
 * @param {string} op - the op name.
 * @param {object} [args] - the op arguments.
 * @param {string} [what] - label for the die() message; defaults to the op name.
 * @returns {*} the op value.
 */
export function muxReq(op, args = {}, what = op) {
  const res = mux(op, args);
  if (!res.ok)
    die(`${activeMux().name} ${what} failed${res.detail ? `: ${res.detail}` : ''}`);
  return res.value;
}

// --- core IO helpers: reliability logic written once, on top of backend primitives ---

// Block the thread for ms (no deps, no subprocess) - lets a pane's TUI settle between a paste
// and the Enter that submits it.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Type one submitted line into a pane: literal text, then a separate Enter to submit. Good for
 * a shell prompt (e.g. launching an agent); to hand a task to an agent composer use sendMessage.
 * @param {string} paneId - target pane.
 * @param {string} text - line of text to type and submit.
 */
export function sendLine(paneId, text) {
  mux('typeText', { paneId, text });
  mux('submitKey', { paneId });
}

/**
 * Drop faint/dim (SGR 2) "ghost text" from ANSI-captured pane content, then strip every
 * remaining escape sequence. Claude's composer renders autocomplete suggestions dim; without
 * this a composer scan would read a ghost suggestion as unsent text and falsely report a
 * failed submit. Pure, exported for tests.
 * @param {string} text - ANSI-captured pane text.
 * @returns {string} the text without faint spans or escape sequences.
 */
export function stripGhostText(text) {
  let out = '';
  let faint = false;
  for (let index = 0; index < (text || '').length; index++) {
    if (text[index] === '\x1B') {
      // eslint-disable-next-line no-control-regex -- parsing ANSI escapes is the point here
      const match = text.slice(index).match(/^\x1B\[([0-9;]*)m/);
      if (match) {
        const params = match[1] === '' ? [0] : match[1].split(';').map(Number);
        if (params.includes(2))
          faint = true; // SGR 2: faint on
        if (params.includes(22) || params.includes(0))
          faint = false; // SGR 22 / full reset: normal intensity
        index += match[0].length - 1;
        continue;
      }
      // eslint-disable-next-line no-control-regex -- parsing ANSI escapes is the point here
      const csi = text.slice(index).match(/^\x1B\[[0-9;?]*[A-Z~]/i); // any other CSI: drop
      if (csi) {
        index += csi[0].length - 1;
        continue;
      }
      continue; // lone escape: drop
    }
    if (!faint)
      out += text[index];
  }
  return out;
}

// Is a Claude composer empty (message submitted)? Content after the last prompt line ('❯')
// means text is sitting unsent; ghost text is stripped first (see stripGhostText). No prompt
// (agent already working, or a shell pane) counts as empty so we never falsely block.
function composerEmpty(paneId) {
  const cap = mux('capture', { paneId, ansi: true });
  if (!cap.ok)
    return true;
  const lines = stripGhostText(cap.value).split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const idx = lines[index].indexOf('❯');
    if (idx >= 0)
      return lines[index].slice(idx + 1).replace(/[│─\s]/g, '').length === 0;
  }
  return true;
}

/**
 * Reliably deliver a submitted message to a Claude agent's composer: flatten to one line
 * (an embedded newline would submit half-typed), settle, Enter, VERIFY the composer cleared
 * (a paste-detected line is ingested asynchronously and an immediate Enter is dropped), retry
 * the Enter once. Returns true iff it submitted, so callers report "delivered", not "typed".
 * No bracketed paste: it would leak escape markers into non-TUI targets. See README.md.
 * @param {string} paneId - target pane.
 * @param {string} text - message to deliver (newlines flattened to one line).
 * @returns {boolean} true if the composer verifiably cleared (message submitted).
 */
export function sendMessage(paneId, text) {
  const line = text.replace(/\s*\n\s*/g, '  ').trimEnd(); // one submitted line
  mux('typeText', { paneId, text: line });
  for (let attempt = 0; attempt < 2; attempt++) {
    sleepSync(200); // let the TUI finish ingesting the (possibly paste-detected) input
    mux('submitKey', { paneId });
    sleepSync(150);
    if (composerEmpty(paneId))
      return true; // verified: composer cleared
  }
  return composerEmpty(paneId);
}

/**
 * Complete a submit sendMessage typed but could not land: the text is STILL in the composer,
 * so press Enter and verify - deliberately WITHOUT re-typing, which would duplicate the
 * pending text. `msg send --until-idle` calls this on an interval until the submit lands.
 * @param {string} paneId - target pane whose composer holds unsent text.
 * @returns {boolean} true if the composer verifiably cleared (message submitted).
 */
export function resubmitMessage(paneId) {
  mux('submitKey', { paneId });
  sleepSync(150);
  return composerEmpty(paneId);
}

/**
 * Attach the terminal to a session, or move the existing client to it when already inside the
 * multiplexer. Exits the process with the attach status when a fresh attach ends (matching the
 * terminal handover), and returns after a switch.
 * @param {string} session - session name to attach to or switch to.
 */
export function attachOrSwitch(session) {
  const { switched, status } = muxReq('attach', { name: session }, 'attach');
  if (!switched)
    process.exit(status);
}
