// The multiplexer contract: the op vocabulary every mux backend (tmux built in, zellij, ...)
// implements, dispatched through the shared plugin contract's guarded call path. The model is
// session > group > pane - "group" is the middle container (a tmux window, a zellij tab).
//
// Design rules the ops encode:
// - Creation ops return every id the caller will need ({groupId, paneId}), so callers address
//   by returned handle and never by numeric index (no base-index math, no follow-up probes).
// - listPanes returns structured Pane records; backends own their output parsing. Core logic
//   never sees a backend format string.
// - IO ops are true primitives (typeText/submitKey/capture). Reliability loops (settle, verify,
//   retry) live once in core (lib/mux/index.mjs), built on the primitives - not per backend.
// - Ops marked required must exist on every backend (conformance-tested). The rest are
//   capabilities: a backend that omits one returns UNSUPPORTED through the guarded call path
//   and the caller degrades gracefully.

export { callOp, ERR, err, ok } from '../plugin/contract.mjs';

/**
 * The backend-neutral pane record listPanes returns.
 *
 * Slot correlation is label-first: spawnPane/setLabel stamp the slot label on the pane (tmux:
 * the @cclabel pane option; zellij: the pane name), and gatherers match on it, falling back to
 * deriving from cwd for panes created before labels existed. cwd is the pane's start path on
 * tmux and the current cwd on zellij - close enough for the fallback, not for primary identity.
 *
 * @typedef {object} Pane
 * @property {string} id - opaque backend pane handle (tmux '%3', zellij 'terminal_3')
 * @property {string} session - owning session name
 * @property {string} group - owning group handle (tmux window id, zellij tab id)
 * @property {string} label - the stamped label ('' when never stamped)
 * @property {string} cwd - pane directory (see above)
 * @property {string} command - foreground command ('' when the backend cannot report one)
 * @property {boolean} focused - is this the focused pane
 * @property {boolean} attached - is the owning session attached to a client
 * @property {boolean} exited - has the pane's program exited (zellij reports; tmux always false)
 */

/**
 * The op catalog, as data so conformance tests iterate it: name -> { req, sig }. `sig` is
 * documentation; the envelope rule (ok/err) comes from the plugin contract.
 */
export const MUX_OPS = {
  // session lifecycle
  probe: { req: true, sig: '() -> ok({name, version}) | err(NOT_INSTALLED)' },
  insideMux: { req: true, sig: '() -> ok(boolean) - is this process running inside this multiplexer' },
  sessionExists: { req: true, sig: '({name}) -> ok(boolean)' },
  listSessions: { req: true, sig: '() -> ok([{name, lastActivity, groups, attached}])' },
  createSession: { req: true, sig: '({name, cwd, firstGroupLabel}) -> ok({firstGroupId, firstPaneId}) - created detached' },
  killSession: { req: true, sig: '({name}) -> ok() - idempotent, a missing session is fine' },
  attach: { req: true, sig: '({name}) -> ok({switched, status}) - hands the terminal over; switched=true moved an existing client instead' },

  // group + pane lifecycle
  createGroup: { req: true, sig: '({session, label, cwd}) -> ok({groupId, paneId})' },
  spawnPane: { req: true, sig: '({group, cwd, label}) -> ok({paneId}) - label stamped at spawn' },
  listGroups: { req: true, sig: '({session}) -> ok([{id, label, paneCount}])' },
  listPanes: { req: true, sig: '({scope: \'all\' | {session} | {group}}) -> ok([Pane])' },
  setLabel: { req: true, sig: '({paneId, label}) -> ok()' },
  setGroupLabel: { req: true, sig: '({groupId, label}) -> ok()' },
  focus: { req: true, sig: '({paneId}) -> ok() - move the highlight to a pane (and its group)' },

  // io primitives (reliability loops live in core, not here)
  typeText: { req: true, sig: '({paneId, text}) -> ok() - literal text, nothing interpreted, no submit' },
  submitKey: { req: true, sig: '({paneId}) -> ok() - press Enter' },
  capture: { req: true, sig: '({paneId, full, ansi}) -> ok(text) - visible screen; full adds scrollback; ansi keeps escape sequences' },

  // capabilities (optional; callers handle UNSUPPORTED)
  // streaming: the pane mirror's substrate. streamStart is THE named shell-string
  // exception in the codebase (tmux pipe-pane executes its argument via a shell) - its
  // inputs are validated in the backend (sink charset, integer byteCap) and nothing
  // request-derived may ever reach it; callers pass only their own spool paths.
  streamStart: { req: false, sig: '({paneId, sink, byteCap}) -> ok({started: true}) - continuously append pane output bytes to sink, capped at byteCap' },
  streamStop: { req: false, sig: '({paneId}) -> ok(true) - stop the stream; idempotent, no-stream is fine' },
  streamStatus: { req: false, sig: '({paneId}) -> ok({piped: boolean}) - is a stream currently attached' },
  paneSize: { req: false, sig: '({paneId}) -> ok({cols, rows}) - current pane geometry' },
  detach: { req: false, sig: '({name?}) -> ok() - detach self (no name) or every client of a session' },
  panePid: { req: false, sig: '({paneId}) -> ok(pid) - the pane shell pid, for process-tree work' },
  arrangeLayout: { req: false, sig: '({group, layout: \'tile-horizontal\'}) -> ok() - best-effort' },
  ensureLabelsVisible: { req: false, sig: '() -> ok({path, changed}) - one-time config so labels render' },
  labelsVisible: { req: false, sig: '() -> ok({ok, source, value}) - doctor probe for the above' },
};

/** The ops every backend must implement - conformance tests iterate this. */
export const REQUIRED_OPS = Object.entries(MUX_OPS)
  .filter(([, op]) => op.req)
  .map(([name]) => name);
