// Test stand-in for lib/serve/mirror-worker.mjs: same message protocol, in-memory mux.
// Behavior knobs ride the pane/slot names; actions are logged to $MIRROR_FAKE_LOG.
import { appendFileSync, existsSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';

const writers = new Map(); // paneId -> {timer, sink}
const log = line => appendFileSync(process.env.MIRROR_FAKE_LOG, `${line}\n`);

function handle(message) {
  const { op } = message;
  if (op === 'resolve') {
    if (message.slot === 'gone')
      return { ok: false, err: 'slot-gone' };
    if (message.slot === 'slowpane') {
      const until = Date.now() + 300; // a deliberately BLOCKING worker (spawnSync-like)
      while (Date.now() < until) { /* spin */ }
    }
    return {
      ok: true,
      value: {
        paneId: `%${message.slot}`,
        cols: 120,
        rows: 32,
        streamSupported: message.slot !== 'nostream',
      },
    };
  }
  if (op === 'pipeStart') {
    log(`pipeStart ${message.paneId}`);
    if (message.paneId === '%failpipe')
      return { ok: false, err: 'tmux pipe-pane failed' };
    const timer = setInterval(() => {
      try {
        appendFileSync(message.sink, 'FAKE-PANE-BYTES\n');
      }
      catch { /* sink rotated away */ }
    }, 30);
    writers.set(message.paneId, { timer, sink: message.sink });
    return { ok: true, value: true };
  }
  if (op === 'pipeStop') {
    log(`pipeStop ${message.paneId}`);
    const writer = writers.get(message.paneId);
    if (writer) {
      clearInterval(writer.timer);
      writers.delete(message.paneId);
    }
    return { ok: true, value: true };
  }
  if (op === 'status') {
    const writer = writers.get(message.paneId);
    const dead = writer && existsSync(`${writer.sink}.dead`);
    return { ok: true, value: { piped: !!writer && !dead } };
  }
  if (op === 'seed') {
    log(`seed ${message.paneId}`);
    appendFileSync(message.sink, 'SEEDED-SCREEN');
    return { ok: true, value: true };
  }
  if (op === 'pollStart') {
    log(`pollStart ${message.paneId}`);
    appendFileSync(message.sink, 'POLLED-FRAME');
    return { ok: true, value: true };
  }
  if (op === 'pollStop') {
    log(`pollStop ${message.paneId}`);
    return { ok: true, value: true };
  }
  return { ok: false, err: `unknown op ${op}` };
}

// node --test globs every file under test/ - as a "test" this module must no-op
// (parentPort is null outside a worker).
parentPort?.on('message', (message) => {
  let reply;
  try {
    reply = handle(message);
  }
  catch (err) {
    reply = { ok: false, err: err?.message ?? String(err) };
  }
  parentPort.postMessage({ id: message.id, ...reply });
});
