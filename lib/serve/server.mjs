// sm serve: the zero-dep node:http server - the THIRD registration of the argspec
// surface (CLI parseArgs, MCP inputSchema, and this). Handlers are stateless over
// durable state: a restarted serve is indistinguishable from one that ran forever.
// Serve law (README.md): nothing claimed to be "on disk now" resolves
// import.meta.url-relative (Homebrew Cellar paths go stale under brew upgrade);
// spawns go through the caller-provided, PATH-stable target.
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVE_BODY_MAX, SERVE_PORT, VERSION } from '../constants.mjs';
import { loadSchema } from '../schema.mjs';
import { webExposed, webInputSchema } from '../argspec.mjs';
import { pidIdentityLive } from '../slots/locks.mjs';
import { ensureToken, mintCookie, serveStateDir, tokenAgeDays, verifyCookie, verifyToken } from './auth.mjs';
import { createCommandRunner } from './commands.mjs';
import { createMirrorManager } from './mirror.mjs';
import { createStreamHub } from './stream.mjs';

// One throwable shape for the fixed status taxonomy; the central handler renders it.
class HttpProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

// Read a JSON body under the cap; 415 on wrong content-type, 413 over cap, 400 unparseable.
function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('application/json'))
      return rejectPromise(new HttpProblem(415, 'content-type must be application/json'));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > SERVE_BODY_MAX) {
        // pause, don't destroy: the 413 travels back over this same socket, and a
        // destroyed socket turns an honest refusal into a client-side connection reset.
        req.pause();
        rejectPromise(new HttpProblem(413, `body over ${SERVE_BODY_MAX} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      }
      catch {
        rejectPromise(new HttpProblem(400, 'body is not valid JSON'));
      }
    });
    req.on('error', () => rejectPromise(new HttpProblem(400, 'body read failed')));
  });
}

// The exposed-command catalog, derived from the SAME schema dir the argspec layer reads.
function buildCatalog() {
  const tools = [];
  for (const file of readdirSync(new URL('../../schema/commands', import.meta.url))) {
    // Deliberately serve's OWN schema snapshot: the catalog must describe what the
    // loaded argspec code can validate; spawn-target skew is surfaced via the meta flag.
    const spec = loadSchema(`commands/${file}`);
    if (!webExposed(spec))
      continue;
    tools.push({
      tool: file.replace(/\.json$/, ''),
      description: spec.description,
      inputSchema: webInputSchema(spec),
      outcomes: ['ok', ...Object.values(spec['x-exit'] ?? {}), 'error'],
    });
  }
  return tools;
}

function cookieValue(req) {
  const match = /(?:^|;\s*)sm_session=([^;]+)/.exec(req.headers.cookie ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}

// 'bearer' | 'cookie' | null - the KIND matters: CSRF proof is a cookie-auth concern
// (a browser attaches cookies cross-site; it cannot attach an Authorization header).
function authKind(req, token) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ') && verifyToken(token, header.slice(7)))
    return 'bearer';
  const cookie = cookieValue(req);
  return cookie != null && verifyCookie(token, cookie) ? 'cookie' : null;
}

// Same-origin proof for command POSTs: an explicit cross-site Sec-Fetch-Site always
// refuses (defense in depth, any auth kind). Absent the header entirely, only bearer
// scripting (curl) passes - sm hosts no pages at its own origin, so there is no Origin
// a cookie-authed browser request could legitimately present.
function sameOriginOk(req, kind) {
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site)
    return site === 'same-origin' || site === 'none';
  return kind === 'bearer';
}

/**
 * Start the serve HTTP server. Exported for hermetic tests (cmdServe resolves the
 * inputs); binds 127.0.0.1 only.
 * @param {object} options - Server inputs.
 * @param {number} [options.port] - Port (0 = ephemeral, for tests).
 * @param {string} options.spawnTarget - The sm binary commands spawn ($SM_SERVE_BIN or PATH 'sm').
 * @param {object} [options.repos] - Registered repos: name -> absolute repo dir.
 * @returns {Promise<{server: import('node:http').Server, port: number, token: string, close: () => Promise<void>}>} the running server.
 */
export async function startServe({ port = SERVE_PORT, spawnTarget, repos = {}, spawnTimeoutMs = undefined, streamIntervals = undefined, mirrorOptions = undefined } = {}) {
  const token = ensureToken();
  // Single instance per state dir: a second serve would double-poll, double-mirror, and
  // race the first for pipes. Pid-identity liveness (fails toward alive); a stale holder
  // (crash, kill -9) is overwritten.
  const pidPath = join(serveStateDir(), 'serve.pid');
  try {
    const holder = JSON.parse(readFileSync(pidPath, 'utf8'));
    if (holder?.pid && holder.pid !== process.pid && pidIdentityLive({ pid: holder.pid, pidStart: null }))
      throw new Error(`sm serve already running (pid ${holder.pid}) - one instance per state dir`);
  }
  catch (err) {
    if (String(err?.message ?? '').startsWith('sm serve already running'))
      throw err;
    // absent or corrupt pidfile: ours to take
  }
  writeFileSync(pidPath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, { mode: 0o600 });
  // The skew probe: ask the SPAWN TARGET its version once at startup. Its answer names
  // what commands will actually run; serve's own VERSION names the loaded code.
  let binaryVersion = null;
  try {
    const probe = spawnSync(spawnTarget, ['version', '--json'], { encoding: 'utf8', timeout: 10_000 });
    binaryVersion = probe.status === 0 ? (JSON.parse(probe.stdout)['slot-machine'] ?? JSON.parse(probe.stdout).version ?? null) : null;
  }
  catch {
    binaryVersion = null;
  }
  const catalog = buildCatalog();
  const runner = createCommandRunner({
    spawnTarget,
    repos,
    isSkewed: () => binaryVersion !== VERSION,
    ...(spawnTimeoutMs != null ? { spawnTimeoutMs } : {}),
  });
  const mirror = createMirrorManager(mirrorOptions ?? {});
  await mirror.sweep(); // reconcile a crashed predecessor's registry before anything opens
  const hub = createStreamHub({ spawnTarget, repos, intervals: streamIntervals, mirror });

  const server = createServer(async (req, res) => {
    try {
      const actualPort = server.address().port;
      const host = String(req.headers.host ?? '');
      if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`)
        throw new HttpProblem(421, 'host not on the allowlist');

      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      const path = url.pathname;

      if (path === '/api/v1/healthz') {
        if (req.method !== 'GET')
          throw new HttpProblem(405, 'method not allowed');
        return json(res, 200, { ok: true });
      }

      if (path === '/api/v1/session') {
        if (req.method !== 'POST')
          throw new HttpProblem(405, 'method not allowed');
        const body = await readJsonBody(req);
        if (!verifyToken(token, body.token))
          throw new HttpProblem(401, 'bad pairing token');
        const cookie = mintCookie(token);
        res.writeHead(204, {
          'set-cookie': `sm_session=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        });
        return res.end();
      }

      if (!path.startsWith('/api/')) {
        // API-only by design: sm never serves HTML. The cockpit runs on its OWN origin
        // and proxies /api here (same-origin for the browser; cookie model untouched).
        throw new HttpProblem(404, 'sm serve is API-only - run the cockpit on its own origin and proxy /api here');
      }

      // Everything else under /api/ requires a session (or Bearer token, for curl).
      const kind = authKind(req, token);
      if (!kind)
        throw new HttpProblem(401, 'no valid session - pair via the printed URL');

      if (path.startsWith('/api/v1/commands/')) {
        if (req.method !== 'POST')
          throw new HttpProblem(405, 'method not allowed');
        if (!sameOriginOk(req, kind))
          throw new HttpProblem(403, 'no same-origin proof');
        const body = await readJsonBody(req);
        const { status, payload } = await runner.run(path.slice('/api/v1/commands/'.length), body);
        return json(res, status, payload);
      }

      const streamMatch = /^\/api\/v1\/repos\/([^/]+)\/stream$/.exec(path);
      if (streamMatch) {
        if (req.method !== 'GET')
          throw new HttpProblem(405, 'method not allowed');
        const repoName = decodeURIComponent(streamMatch[1]);
        if (!repos[repoName])
          throw new HttpProblem(404, 'unknown repo (must be a registered repo name)');
        return hub.handle(req, res, repoName, url);
      }

      if (path === '/api/v1/meta') {
        if (req.method !== 'GET')
          throw new HttpProblem(405, 'method not allowed');
        return json(res, 200, {
          v: 1,
          serveVersion: VERSION,
          binaryVersion,
          skew: binaryVersion !== VERSION,
          repos: Object.keys(repos),
          tokenAgeDays: tokenAgeDays(),
          seat: null, // the desk-seat external arm wires in when it ships
        });
      }

      if (path === '/api/v1/commands') {
        if (req.method !== 'GET')
          throw new HttpProblem(405, 'method not allowed');
        return json(res, 200, { v: 1, tools: catalog });
      }

      throw new HttpProblem(404, 'not found');
    }
    catch (problem) {
      const status = problem instanceof HttpProblem ? problem.status : 500;
      if (!res.headersSent)
        json(res, status, { error: problem.message ?? 'internal error' });
      else res.end();
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', resolvePromise);
  });
  return {
    server,
    port: server.address().port,
    token,
    close: async () => {
      // Teardown order: tell every SSE client this is a shutdown (they reconnect with
      // their cursor against the next serve), stop every mirror pipe (no linger), drop
      // sockets, close, release the instance pidfile.
      hub.closeAll();
      await mirror.shutdown();
      await new Promise((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => {
          rmSync(pidPath, { force: true });
          resolvePromise();
        });
      });
    },
  };
}
