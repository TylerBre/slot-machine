// The command endpoint's runner: validate against the web schema, build argv through
// the SAME buildArgv the MCP server uses, spawn the PATH-stable target with an argv
// array - never a shell, so no request-derived byte can be interpreted - and wrap the
// exit in the versioned envelope. Stateless beyond the pool counters and the per-repo
// dispatch queues, which are liveness aids, not correctness state.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { SERVE_POOL_BLOCKING, SERVE_POOL_INTERACTIVE, SERVE_SPAWN_TIMEOUT_MS } from '../constants.mjs';
import { buildArgv, commandOutcome, webExposed, webInputSchema } from '../argspec.mjs';
import { loadSchema, validate } from '../schema.mjs';

// Reads never mutate fleet state; they ride through version skew. A stale serve may
// still OBSERVE the fleet, but it must not MUTATE through a newer binary whose
// semantics its loaded schemas cannot describe. Everything unlisted is mutating.
const READ_TOOLS = new Set([
  'floor',
  'journal',
  'msg-inbox',
  'slot-ls',
  'slot-inspect',
  'worker-ps',
  'lock-ls',
  'session-ls',
  'repo-ls',
  'version',
  'watch',
  'worker-logs',
]);

// URL path segment -> schema filename; the charset gate is the traversal defense
// (loadSchema joins the name into the schema dir).
const TOOL_NAME = /^[a-z][a-z-]*$/;

/**
 * Build the command runner startServe mounts. All decisions return {status, payload} -
 * the HTTP layer owns headers/sockets, this owns policy.
 * @param {object} options - Runner inputs.
 * @param {string} options.spawnTarget - The sm binary (PATH-stable; see cmdServe).
 * @param {object} options.repos - Registered repos: name -> absolute repo dir.
 * @param {() => boolean} options.isSkewed - Version-skew signal (meta's flag).
 * @param {number} [options.spawnTimeoutMs] - Per-child ceiling (tests shrink it).
 * @returns {{run: (tool: string, body: object) => Promise<{status: number, payload: object}>}} the runner.
 */
export function createCommandRunner({ spawnTarget, repos, isSkewed, spawnTimeoutMs = SERVE_SPAWN_TIMEOUT_MS }) {
  const pools = { interactive: 0, blocking: 0 };
  const caps = { interactive: SERVE_POOL_INTERACTIVE, blocking: SERVE_POOL_BLOCKING };
  const workerRunTail = new Map(); // repoDir -> promise tail: per-repo dispatch serialization

  function spawnOnce(argv) {
    return new Promise((resolvePromise) => {
      // detached: the child leads its own process group, so the timeout kill reaches
      // grandchildren too (a killed sh whose sleep/git child inherited our stdio pipes
      // would otherwise hold 'close' hostage until IT exited).
      const child = spawn(spawnTarget, argv, { env: { ...process.env, NO_COLOR: '1' }, detached: true });
      const stdout = [];
      const stderr = [];
      let settled = false;
      const settle = (result) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL'); // the whole group
        }
        catch {
          child.kill('SIGKILL');
        }
        // resolve NOW: the 504 must not wait for orphaned grandchildren to release pipes
        settle({ code: null, stdout: '', stderr: '', timedOut: true });
      }, spawnTimeoutMs);
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => stderr.push(chunk));
      child.on('error', () => settle({ code: null, stdout: '', stderr: `could not spawn ${spawnTarget}`, timedOut: false }));
      child.on('close', code => settle({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut: false,
      }));
    });
  }

  async function run(tool, body) {
    if (!TOOL_NAME.test(String(tool ?? '')))
      return { status: 404, payload: { error: 'unknown tool' } };
    let spec;
    try {
      spec = loadSchema(`commands/${tool}.json`);
    }
    catch {
      return { status: 404, payload: { error: 'unknown tool' } };
    }
    if (!webExposed(spec))
      return { status: 403, payload: { error: `${tool} is not exposed on the web surface` } };

    // The repo pin: exact registered-name match only, resolved serve-side to an absolute
    // dir, refused BEFORE any spawn. resolveActive would happily take an arbitrary path,
    // so this gate is the only backstop and is treated as such.
    const repoDir = typeof body.repo === 'string' ? repos[body.repo] : undefined;
    if (!repoDir)
      return { status: 404, payload: { error: 'unknown repo (must be a registered repo name)' } };

    if (isSkewed() && !READ_TOOLS.has(tool))
      return { status: 503, payload: { error: 'serve/binary version skew - restart sm serve before mutating' } };

    const args = body.args ?? {};
    const problems = validate(args, webInputSchema(spec));
    if (problems.length)
      return { status: 400, payload: { error: `invalid args: ${problems.join('; ')}` } };
    let argv;
    try {
      argv = buildArgv(spec, args);
    }
    catch (err) {
      return { status: 400, payload: { error: err.message } };
    }
    // --json rides BEFORE the '--' terminator (after it, it would be a literal positional);
    // the repo pin goes first (the router consumes it ahead of route resolution).
    const dd = argv.indexOf('--');
    const withJson = dd >= 0 ? [...argv.slice(0, dd), '--json', ...argv.slice(dd)] : [...argv, '--json'];
    const fullArgv = ['--repo', repoDir, ...withJson];

    const pool = tool === 'msg-send' && args.untilIdle === true ? 'blocking' : 'interactive';
    if (pools[pool] >= caps[pool])
      return { status: 429, payload: { error: `the ${pool} pool is full - retry shortly`, pool } };
    pools[pool] += 1;
    try {
      let result;
      if (tool === 'worker-run') {
        // One dispatch at a time per repo: concurrent worker-runs would race the same
        // free-slot pool; the conditional claim makes that safe, serialization makes it
        // orderly (second dispatch sees the first's claim instead of losing a race).
        const tail = workerRunTail.get(repoDir) ?? Promise.resolve();
        const next = tail.then(() => spawnOnce(fullArgv));
        workerRunTail.set(repoDir, next.then(() => {}, () => {}));
        result = await next;
      }
      else {
        result = await spawnOnce(fullArgv);
      }
      if (result.timedOut)
        return { status: 504, payload: { error: 'command exceeded the serve time ceiling' } };
      const { ok, outcome } = commandOutcome(spec, result.code ?? 1);
      const payload = { v: 1, ok, outcome };
      try {
        payload.data = JSON.parse(result.stdout);
      }
      catch {
        if (result.stdout.trim())
          payload.data = { raw: result.stdout };
      }
      if (!ok)
        payload.error = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      return { status: 200, payload };
    }
    finally {
      pools[pool] -= 1;
    }
  }

  return { run };
}
