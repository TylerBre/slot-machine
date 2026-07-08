// Repo resolution + persisted config. A repo's whole context is derived from its
// main-worktree dir: root = the parent dir (slots are siblings), prefix = <name>-slot-,
// session prefix = <name>, base = the repo's default branch. Overridable and
// persisted per-repo in ~/.config/slot/config.json; `sm repo use` sets the current repo.
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadSchema, validate } from './schema.mjs';
import { elevate } from './elevators.mjs';

export const CONFIG_FILE = join(homedir(), '.config', 'slot', 'config.json');

const CONFIG_SCHEMA = loadSchema('config.schema.json');
export const CONFIG_SCHEMA_VERSION = CONFIG_SCHEMA.properties.v.const;

// v0 (legacy, no `v`) -> v1: stamp version, default the two top-level containers. Repo entries were
// written by saveConfig from deriveContext, so they are assumed well-formed; a malformed one is
// surfaced loudly by loadConfig's validate rather than silently patched.
const CONFIG_ELEVATORS = [
  raw => ({ v: 1, current: raw.current ?? null, repos: raw.repos ?? {} }),
];

/**
 * Elevate a raw parsed config (any version) up to the current schema version.
 * @param {object} raw - the raw parsed config.
 * @returns {object} the config elevated to CONFIG_SCHEMA_VERSION.
 */
export function elevateConfig(raw) {
  return elevate(raw, CONFIG_ELEVATORS, CONFIG_SCHEMA_VERSION);
}

// Set by loadConfig when the on-disk config is present but unusable (unparseable / not an object /
// schema-invalid). A live binding read across modules is the point here: the router reads it to
// fail non-tolerant commands loud, while doctor + help stay alive to diagnose it. null means the
// config is fine (or absent, which is fine).
// eslint-disable-next-line import/no-mutable-exports -- intentional cross-module live binding
export let CONFIG_ERROR = null;

/**
 * Load the persisted slot config, elevated and validated. Never throws or exits (it runs at import
 * time via resolveActive, so a hard exit here would kill every command): a missing/unreadable file
 * is a valid empty config and leaves CONFIG_ERROR null; a corrupt, non-object, or schema-invalid
 * file records the reason in CONFIG_ERROR and degrades to an empty config so diagnostic commands
 * (sm doctor, sm help) still run. Repo-needing commands enforce CONFIG_ERROR loudly in the router.
 * @returns {object} the elevated config ({ v, current, repos }); an empty one when CONFIG_ERROR is set.
 */
export function loadConfig() {
  CONFIG_ERROR = null; // recompute from the current file on every call
  let text;
  try {
    text = readFileSync(CONFIG_FILE, 'utf8');
  }
  catch {
    return elevateConfig({}); // missing/unreadable -> a fresh empty config (not an error)
  }
  let raw;
  try {
    raw = JSON.parse(text);
  }
  catch (err) {
    CONFIG_ERROR = `config at ${CONFIG_FILE} is not valid JSON (${err.message}). fix or remove it and retry.`;
    return elevateConfig({});
  }
  // The config must be a JSON object; an array/number/string/boolean/null would otherwise be
  // silently coerced to an empty config by elevateConfig, hiding a real mistake.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    CONFIG_ERROR = `config at ${CONFIG_FILE} is invalid: not an object. fix or remove it and retry.`;
    return elevateConfig({});
  }
  const cfg = elevateConfig(raw);
  const problems = validate(cfg, CONFIG_SCHEMA);
  if (problems.length) {
    CONFIG_ERROR = `config at ${CONFIG_FILE} is invalid:\n  ${problems.join('\n  ')}\n  fix or remove it and retry.`;
    return elevateConfig({}); // degrade to empty so tolerant commands can still run
  }
  return cfg;
}

/**
 * Persist the slot config, validating first so a malformed config never reaches disk.
 * @param {object} cfg - the config to write ({ current, repos }); the current `v` is stamped on.
 */
export function saveConfig(cfg) {
  const stamped = { v: CONFIG_SCHEMA_VERSION, current: cfg.current ?? null, repos: cfg.repos ?? {} };
  const problems = validate(stamped, CONFIG_SCHEMA);
  if (problems.length)
    throw new Error(`refusing to save invalid config:\n  ${problems.join('\n  ')}`);
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(stamped, null, 2)}\n`);
}

/**
 * The main worktree path for a git dir (resolves a slot worktree back to its repo).
 * @param {string} dir - A directory inside the git repo (main or slot worktree).
 * @returns {string|null} The main worktree path, or null if `dir` is not a git dir.
 */
export function mainWorktree(dir) {
  const res = spawnSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (res.status !== 0)
    return null;
  const match = (res.stdout || '').match(/^worktree (.+)$/m); // first entry is the main worktree
  return match ? match[1] : null;
}

/**
 * The repo's default branch name (from origin/HEAD), falling back to 'main'.
 * @param {string} dir - A directory inside the git repo.
 * @returns {string} The default branch name.
 */
export function defaultBranch(dir) {
  const res = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    encoding: 'utf8',
  });
  const branch = res.status === 0 ? res.stdout.trim().replace(/^origin\//, '') : '';
  return branch || 'main';
}

/**
 * Derive a repo context from a repo's main-worktree dir, applying stored/flag overrides.
 * @param {string} repoDir - The repo's main-worktree directory.
 * @param {object} [over] - Optional overrides for prefix, sessionPrefix, and baseBranch.
 * @returns {object} The derived repo context.
 */
export function deriveContext(repoDir, over = {}) {
  const name = basename(repoDir);
  return {
    repoDir,
    name,
    root: dirname(repoDir),
    prefix: over.prefix || `${name}-slot-`,
    sessionPrefix: over.sessionPrefix || name,
    baseBranch: over.baseBranch || 'main',
  };
}

function repoFlag(argv) {
  const idx = argv.indexOf('--repo');
  if (idx >= 0 && argv[idx + 1])
    return argv[idx + 1];
  const eq = argv.find(arg => arg.startsWith('--repo='));
  return eq ? eq.slice('--repo='.length) : null;
}

/**
 * The active repo for this invocation: --repo DIR (one-off) wins, else the persisted
 * current repo. Returns a full context, or null if none is resolvable.
 * @param {string[]} argv - The CLI argument vector to scan for a --repo flag.
 * @returns {object|null} The resolved repo context, or null if none is resolvable.
 */
export function resolveActive(argv) {
  const cfg = loadConfig();
  const rf = repoFlag(argv);
  if (rf) {
    const main = mainWorktree(resolve(rf)) || resolve(rf);
    if (cfg.repos && cfg.repos[main])
      return { repoDir: main, ...cfg.repos[main] };
    return { ...deriveContext(main), baseBranch: defaultBranch(main) };
  }
  if (cfg.current && cfg.repos && cfg.repos[cfg.current])
    return { repoDir: cfg.current, ...cfg.repos[cfg.current] };
  return null;
}
