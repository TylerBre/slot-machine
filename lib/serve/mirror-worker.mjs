// The mirror's mux arm, on a worker thread. Every mux backend op is spawnSync-blocking
// (and the poll-dump fallback deliberately loops captures), so ALL of it lives here -
// the HTTP loop never waits on a mux call. Loading this module via import.meta.url is
// module resolution of the running code, not an "on disk now" claim - the serve law
// concerns the latter.
//
// Protocol: parent posts {id, op, ...args}; worker answers {id, ok, value} | {id, ok:
// false, err}. Poll-dump sessions run worker-side intervals that append to the spool,
// so the parent's spool-tailing is uniform across pipe and poll modes.
import { appendFileSync, readFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { resolveActive } from '../context.mjs';
import { activeMux, mux } from '../mux/index.mjs';
import { paneLabel } from '../slots/pure.mjs';

const polls = new Map(); // paneId -> {timer, last}

// Poll-dump fallback: full-screen captures diffed by replacement - when the screen
// changed, append a clear+home then the new frame, so xterm renders it as a redraw.
const CLEAR = '[2J[H';

function resolvePane({ repoDir, slot }) {
  const active = resolveActive(['--repo', repoDir]);
  if (!active)
    return { ok: false, err: 'repo did not resolve' };
  const sessionPrefix = String(active.session ?? '').replace(/\*+$/, '');
  const listed = mux('listPanes', { scope: 'all' });
  if (!listed.ok)
    return { ok: false, err: 'mux listPanes failed' };
  // Session-prefix first (labels are per-repo vocabulary; two repos may both have a
  // slot 'a'), then the same label-first correlation every gatherer uses.
  const pane = listed.value
    .filter(candidate => sessionPrefix === '' || String(candidate.session ?? '').startsWith(sessionPrefix))
    .find(candidate => paneLabel(candidate, active.root, active.prefix) === slot);
  if (!pane)
    return { ok: false, err: 'slot-gone' };
  const backend = activeMux();
  const streamSupported = typeof backend.streamStart === 'function';
  const size = typeof backend.paneSize === 'function' ? mux('paneSize', { paneId: pane.id }) : null;
  return {
    ok: true,
    value: {
      paneId: pane.id,
      cols: size?.ok ? size.value.cols : 80,
      rows: size?.ok ? size.value.rows : 24,
      streamSupported,
    },
  };
}

function handle(message) {
  const { op } = message;
  if (op === 'resolve')
    return resolvePane(message);
  if (op === 'pipeStart') {
    const res = mux('streamStart', { paneId: message.paneId, sink: message.sink, byteCap: message.byteCap });
    return res.ok ? { ok: true, value: true } : { ok: false, err: res.detail ?? res.err };
  }
  if (op === 'pipeStop') {
    mux('streamStop', { paneId: message.paneId });
    return { ok: true, value: true };
  }
  if (op === 'status') {
    const res = mux('streamStatus', { paneId: message.paneId });
    return res.ok ? { ok: true, value: res.value } : { ok: false, err: res.detail ?? res.err };
  }
  if (op === 'pollStart') {
    const { paneId, sink, ms } = message;
    if (!polls.has(paneId)) {
      const state = { last: null, timer: null };
      state.timer = setInterval(() => {
        const cap = mux('capture', { paneId, ansi: true });
        if (!cap.ok)
          return;
        if (cap.value !== state.last) {
          state.last = cap.value;
          try {
            appendFileSync(sink, CLEAR + cap.value);
          }
          catch { /* sink rotated/removed underneath: the next diff re-appends */ }
        }
      }, ms);
      polls.set(paneId, state);
    }
    return { ok: true, value: true };
  }
  if (op === 'pollStop') {
    const state = polls.get(message.paneId);
    if (state) {
      clearInterval(state.timer);
      polls.delete(message.paneId);
    }
    return { ok: true, value: true };
  }
  if (op === 'readSpoolSize') {
    try {
      return { ok: true, value: readFileSync(message.sink).length };
    }
    catch {
      return { ok: true, value: 0 };
    }
  }
  return { ok: false, err: `unknown op ${op}` };
}

parentPort.on('message', (message) => {
  let reply;
  try {
    reply = handle(message);
  }
  catch (err) {
    reply = { ok: false, err: err?.message ?? String(err) };
  }
  parentPort.postMessage({ id: message.id, ...reply });
});
