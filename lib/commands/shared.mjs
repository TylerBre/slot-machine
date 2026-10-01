// Cross-command helpers shared by more than one namespace module.
import { parseArgs } from 'node:util';
import { REPO_NAME, SESSION_PREFIX } from '../constants.mjs';
import { toParseArgs } from '../argspec.mjs';
import { clr, die, formatSessions, startSpinner } from '../format.mjs';
import { mux } from '../mux/index.mjs';
import { sessionRows, slotFreenessRows } from '../slots/gather.mjs';
import { readWorker, writeWorker } from '../slots/locks.mjs';
import { appendJournal } from '../slots/journal.mjs';
import { loadSchema } from '../schema.mjs';

/**
 * Shared parseArgs wrapper: every command gets --json/--help for free and dies in one
 * voice on unknown flags. Handlers never see --help (the router prints route help first).
 * @param {string} who - command label used in the die() message on a parse error.
 * @param {string[]} argv - CLI arguments to parse.
 * @param {object} [options] - extra parseArgs options for this command, merged with json/help.
 * @returns {{values: object, positionals: string[]}|undefined} the parsed args; dies (never returns) on error.
 */
export function parseCmd(who, argv, options = {}) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        ...options,
      },
    });
  }
  catch (err) {
    die(`${who}: ${err.message} (try --help)`);
  }
}

/**
 * A command's parseArgs options, derived from its arg-spec - the single source shared with
 * the MCP tool's inputSchema, so the CLI parser can never drift from the spec.
 * @param {string} name - arg-spec file name under schema/commands, without extension.
 * @returns {object} the parseArgs options map, keyed by CLI flag name.
 */
export const argOptions = name => toParseArgs(loadSchema(`commands/${name}.json`));

/**
 * slotFreenessRows behind a spinner (skipped when quiet/--json).
 * @param {boolean} quiet - suppress the spinner (e.g. --json mode).
 * @param {string} [text] - spinner label while the rows are gathered.
 * @returns {Promise<object[]>} the classified slot rows, sorted by slot label.
 */
export async function freenessRows(quiet, text = 'checking slots (git fetch + gh pr)...') {
  const stop = quiet ? () => {} : startSpinner(text);
  try {
    return await slotFreenessRows();
  }
  finally {
    stop();
  }
}

/**
 * Shared watch loop: snapshot first (possibly slow), then clear + render - no blank flash.
 * @param {string} header - title line printed above each render.
 * @param {number} ms - refresh interval in milliseconds.
 * @param {() => Promise<*>} snap - takes a fresh snapshot to render.
 * @param {(snapshot: *) => void} render - renders a snapshot to the screen.
 * @returns {Promise<never>} never resolves; loops until the process is interrupted.
 */
export async function watchLoop(header, ms, snap, render) {
  for (;;) {
    const shot = await snap();
    process.stdout.write('\x1B[2J\x1B[H');
    console.log(clr.dim(`${header}  (watch: refresh ${ms / 1000}s, Ctrl-C to stop)\n`));
    render(shot);
    await new Promise(done => setTimeout(done, ms));
  }
}

// Journal appends on the dispatch hot path degrade to a warning: history is an operational
// aid, not an audit ledger - a full disk must never block delivery.
function journalSoft(record) {
  try {
    appendJournal(REPO_NAME, record);
  }
  catch (err) {
    console.error(`journal: could not record ${record.type} for slot ${record.slot} - ${err.message}`);
  }
}

/**
 * Record a worker (the conversation) on its slot's document at spawn/dispatch time, and journal
 * worker-created the FIRST time this slot gains one. Owned-field merge underneath: re-recording
 * agent/model/transport never nulls a sessionId this writer did not mint. Degrades to a warning
 * on journal failure; document-write failure surfaces (the document is load-bearing).
 * @param {string} dir - the slot worktree directory.
 * @param {string} label - the slot label (journal tag).
 * @param {object} fields - resolved worker fields.
 * @param {string} fields.agent - the resolved agent instance name.
 * @param {string|null} [fields.model] - the model override in effect.
 * @param {string} [fields.transport] - pane | headless.
 */
export function recordWorker(dir, label, { agent, model = null, transport = 'pane' } = {}) {
  const first = readWorker(dir) == null;
  if (first)
    journalSoft({ slot: label, type: 'worker-created', agent: agent ?? null, transport });
  writeWorker(dir, { agent, model, transport });
}

/**
 * Journal a verified pane delivery: a post-verification fact (the composer verifiably cleared),
 * recorded after the claim write and before the CLI reports it. Control messages and
 * unsubmitted/dead targets journal nothing (their state lives in the command output).
 * @param {string} label - the slot label.
 * @param {string} task - the delivered task text.
 */
export function journalDispatch(label, task) {
  journalSoft({ slot: label, type: 'task-dispatched', task, submitted: true });
}

/**
 * Resolve the target session: explicit -t wins; else the sole running acme* session.
 * @param {string|undefined} explicit - session name from -t, if given.
 * @param {string} who - command label used in die()/error messages.
 * @returns {string} the resolved, live tmux session name; dies if none or ambiguous.
 */
export function resolveSession(explicit, who) {
  let sess = explicit;
  if (!sess) {
    const rows = sessionRows();
    if (rows.length === 1) {
      sess = rows[0].name;
    }
    else if (rows.length === 0) {
      die(`${who}: no running ${SESSION_PREFIX}* tmux session; pass one with -t`);
    }
    else {
      console.error(`${who}: several ${SESSION_PREFIX}* sessions are running - pick one with -t:`);
      console.error(formatSessions(rows));
      process.exit(1);
    }
  }
  if (!mux('sessionExists', { name: sess }).value)
    die(`${who}: no session '${sess}'`);
  return sess;
}
