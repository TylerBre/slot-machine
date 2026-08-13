// sm serve: the zero-dep node:http server - the THIRD registration of the argspec
// surface (CLI parseArgs, MCP inputSchema, and this). Handlers are stateless over
// durable state: every request reads fresh, every session cookie verifies against the
// persisted token, and a restarted serve is indistinguishable from one that ran forever.
//
// Serve-side law: no import.meta.url-relative resolution for anything claimed to be
// "on disk now" - under Homebrew, module realpaths land in a versioned Cellar directory
// that goes stale (or vanishes) when `brew upgrade` runs beneath a long-lived server.
// The spawn target and the schema catalog resolve through the caller-provided,
// PATH-stable target instead.
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { SERVE_BODY_MAX, SERVE_PORT, VERSION } from '../constants.mjs';
import { loadSchema } from '../schema.mjs';
import { webExposed, webInputSchema } from '../argspec.mjs';
import { ensureToken, mintCookie, tokenAgeDays, verifyCookie, verifyToken } from './auth.mjs';
import { createCommandRunner } from './commands.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

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
// mtime-refresh is a Task 8 concern; startup read is correct for the skeleton.
function buildCatalog() {
  const tools = [];
  for (const file of readdirSync(new URL('../../schema/commands', import.meta.url))) {
    // NOTE: this read is of serve's OWN schema snapshot (loaded code), deliberately -
    // the catalog must describe what serve's loaded argspec code can validate, and skew
    // against the spawn target is surfaced separately via the meta skew flag.
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
// refuses (defense in depth, any auth kind); absent that header, cookie-authed requests
// must present an allowlisted Origin, while bearer-authed scripting (curl) passes.
function sameOriginOk(req, kind, host) {
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site)
    return site === 'same-origin' || site === 'none';
  const origin = String(req.headers.origin ?? '');
  if (origin) {
    try {
      return new URL(origin).host === host;
    }
    catch {
      return false;
    }
  }
  return kind === 'bearer';
}

// Static hosting with traversal defense: the resolved path must stay under uiDir; misses
// and directories fall back to index.html (SPA routing); strict CSP on everything.
function serveStatic(uiDir, urlPath, res) {
  const root = resolve(uiDir);
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  }
  catch {
    return json(res, 404, { error: 'not found' });
  }
  let file = resolve(root, decoded === '/' ? 'index.html' : decoded.slice(1));
  if (file !== root && !file.startsWith(root + sep))
    return json(res, 404, { error: 'not found' });
  if (!existsSync(file) || statSync(file).isDirectory())
    file = resolve(root, 'index.html');
  if (!existsSync(file))
    return json(res, 404, { error: 'not found' });
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-security-policy': 'default-src \'self\'',
  });
  res.end(readFileSync(file));
}

/**
 * Start the serve HTTP server. Exported for hermetic tests (cmdServe resolves the
 * inputs); binds 127.0.0.1 only.
 * @param {object} options - Server inputs.
 * @param {number} [options.port] - Port (0 = ephemeral, for tests).
 * @param {string|null} [options.uiDir] - Built cockpit dir to host, or null.
 * @param {string} options.spawnTarget - The sm binary commands spawn ($SM_SERVE_BIN or PATH 'sm').
 * @param {object} [options.repos] - Registered repos: name -> absolute repo dir.
 * @returns {Promise<{server: import('node:http').Server, port: number, token: string, close: () => Promise<void>}>} the running server.
 */
export async function startServe({ port = SERVE_PORT, uiDir = null, spawnTarget, repos = {}, spawnTimeoutMs = undefined } = {}) {
  const token = ensureToken();
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
        if (req.method !== 'GET' && req.method !== 'HEAD')
          throw new HttpProblem(405, 'method not allowed');
        if (!uiDir)
          throw new HttpProblem(404, 'no ui hosted (start with --ui <dir>)');
        return serveStatic(uiDir, path, res);
      }

      // Everything else under /api/ requires a session (or Bearer token, for curl).
      const kind = authKind(req, token);
      if (!kind)
        throw new HttpProblem(401, 'no valid session - pair via the printed URL');

      if (path.startsWith('/api/v1/commands/')) {
        if (req.method !== 'POST')
          throw new HttpProblem(405, 'method not allowed');
        if (!sameOriginOk(req, kind, host))
          throw new HttpProblem(403, 'no same-origin proof');
        const body = await readJsonBody(req);
        const { status, payload } = await runner.run(path.slice('/api/v1/commands/'.length), body);
        return json(res, status, payload);
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
    close: () => new Promise((resolvePromise) => {
      server.closeAllConnections?.();
      server.close(resolvePromise);
    }),
  };
}
