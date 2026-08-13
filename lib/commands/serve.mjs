// sm serve: CLI wiring for the cockpit bridge (the server itself lives in lib/serve/).
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { SERVE_PORT } from '../constants.mjs';
import { die } from '../format.mjs';
import { loadConfig } from '../context.mjs';
import { ensureToken } from '../serve/auth.mjs';
import { startServe } from '../serve/http.mjs';
import { argOptions, parseCmd } from './shared.mjs';

// The spawn target must be version-stable across upgrades: $SM_SERVE_BIN (dev escape
// hatch) else `sm` on PATH - the brew opt shim / ~/.local/bin symlink both repoint
// atomically on upgrade. NEVER an import.meta.url-relative sibling (a Homebrew Cellar
// realpath goes stale under a live serve the moment brew upgrade runs).
function resolveSpawnTarget() {
  const target = process.env.SM_SERVE_BIN || 'sm';
  const probe = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (probe.status !== 0)
    die(`serve: spawn target '${target}' failed the startup probe - is sm on PATH? (SM_SERVE_BIN overrides)`);
  return target;
}

/**
 * serve: run the HTTP+SSE bridge for the dispatcher cockpit. Long-running.
 * @param {string[]} argv - CLI arguments for the serve command.
 */
export async function cmdServe(argv) {
  const { values } = parseCmd('serve', argv, argOptions('serve'));
  const port = values.port ? Number(values.port) : SERVE_PORT;
  if (values['rotate-token']) {
    const token = ensureToken({ rotate: true });
    console.log(`token rotated - existing sessions stay valid until expiry is checked against the NEW token (i.e. they are dead); pair again:`);
    console.log(`  http://127.0.0.1:${port}/#token=${token}`);
    return;
  }
  const cfg = loadConfig();
  const repos = {};
  for (const [dir, entry] of Object.entries(cfg.repos ?? {}))
    repos[entry.name ?? basename(dir)] = dir;
  if (!Object.keys(repos).length)
    die('serve: no registered repos - run: sm repo use <repo>');
  const spawnTarget = resolveSpawnTarget();
  const running = await startServe({ port, spawnTarget, repos });
  console.log(`sm serve (API-only) on http://127.0.0.1:${running.port} (repos: ${Object.keys(repos).join(', ')})`);
  // The one-time pairing print. sm serves no HTML - the cockpit runs on its own origin
  // and proxies /api here, so pairing happens THERE: open the cockpit's URL with this
  // fragment. The fragment never reaches a server or a log, but it DOES land in browser
  // history - which is why rotation is cheap and surfaced.
  console.log(`pair from the cockpit's origin: <cockpit-url>/#token=${running.token}`);
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {}); // long-running by design; the signals above end it
}
