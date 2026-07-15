// The agent registry. Loads built-in + user plugins into a roster of instances and resolves a
// slot to a concrete { plugin, model, env }. Pure helpers (expandHome/resolveEntry/resolveModel/
// dependents) carry the decision logic and are unit-tested; loadRoster/resolveInstance wrap them
// with config + dynamic import IO.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../context.mjs';
import { BIN_DIR } from '../setup.mjs';
import claude from './claude.mjs';
import { callOp } from './contract.mjs';

export { callOp };

export const BUILTINS = { claude };

/**
 * Expand a leading ~ or $HOME to the real home dir; leave other paths untouched.
 * @param {string} value - a path or env value.
 * @returns {string} - the expanded path (or the input unchanged, if it did not need expanding).
 */
export function expandHome(value) {
  if (typeof value !== 'string')
    return value;
  if (value === '~')
    return homedir();
  if (value.startsWith('~/'))
    return join(homedir(), value.slice(2));
  if (value.startsWith('$HOME/'))
    return join(homedir(), value.slice(6));
  return value;
}

const DEFAULT_AGENTS_DIR = join(homedir(), '.config', 'slot', 'agents');

/**
 * The global user-plugin dir (settings.agentsDir, expanded), or the default.
 * @param {object} cfg - the loaded config.
 * @returns {string} - the absolute directory user agent plugins are resolved against.
 */
export function agentsDir(cfg) {
  return expandHome(cfg.settings?.agentsDir) || DEFAULT_AGENTS_DIR;
}

// Expand ~ in every value of an instance's env map.
const expandEnv = env => Object.fromEntries(Object.entries(env || {}).map(([key, val]) => [key, expandHome(val)]));

/**
 * The roster entry a slot resolves to: agent chain slot[label].agent -> repo.agent -> 'claude'.
 * Returns { name } - the instance name (caller looks it up in the loaded roster for the plugin).
 * @param {object} cfg - the loaded config.
 * @param {string} repoDir - the current repo's main-worktree dir.
 * @param {string} label - the slot label.
 * @returns {{name: string}} - the resolved instance name.
 */
export function resolveEntry(cfg, repoDir, label) {
  const repo = cfg.repos?.[repoDir] ?? {};
  const name = repo.slots?.[label]?.agent ?? repo.agent ?? 'claude';
  return { name };
}

// The instance an agent name resolves to, and the agent name set at the repo level.
// Walk the `use` chain from `name`, returning the first config- or built-in-declared value
// of field `field` (models/defaultModel), else the fallback. Cycle-safe.
function chainValue(cfg, name, field, fallback) {
  let cur = name;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const entry = cfg.agents?.[cur];
    if (entry && entry[field] != null)
      return entry[field];
    if (BUILTINS[cur])
      return BUILTINS[cur][field];
    cur = entry?.use;
  }
  return fallback;
}

// Limitation: a user plugin that declares `models`/`defaultModel` ONLY in its code (not in the
// roster entry) is seen as open ('*') / null here, because these are pure (no loaded plugin).
// Declaring models in the roster entry (agents add --models) enforces them. Fine for the plan's
// shipped plugins (claude uses '*'); tighten when a code-only closed-set plugin actually lands.
const modelsOf = (cfg, name) => chainValue(cfg, name, 'models', '*');
const defaultModelOf = (cfg, name) => chainValue(cfg, name, 'defaultModel', null);

/**
 * The model a slot resolves to, given its resolved instance name. A model is inherited across a
 * level only if that level resolves to the SAME instance; when the agent is overridden, model
 * resolution restarts at the instance's defaultModel. The final model is validated against the
 * instance's exposed models (throws on mismatch unless models are open).
 * @param {object} cfg - the loaded config.
 * @param {string} repoDir - the current repo's main-worktree dir.
 * @param {string} label - the slot label.
 * @param {string} name - the resolved instance name (from resolveEntry).
 * @returns {string|null} - the resolved model, or null when the instance emits no --model flag.
 */
export function resolveModel(cfg, repoDir, label, name) {
  const repo = cfg.repos?.[repoDir] ?? {};
  const slot = repo.slots?.[label] ?? {};
  const slotAgent = slot.agent ?? repo.agent ?? 'claude';
  const repoAgent = repo.agent ?? 'claude';
  let model = null;
  if (slot.model != null && slotAgent === name)
    model = slot.model;
  else if (repo.model != null && repoAgent === name)
    // inherit the repo model whenever the slot resolves to the repo's instance - including
    // when the slot redundantly restates that same agent (repoAgent === name covers both).
    model = repo.model;
  model ??= defaultModelOf(cfg, name);
  const models = modelsOf(cfg, name);
  if (model != null && Array.isArray(models) && !models.includes(model))
    throw new Error(`model '${model}' is not exposed by agent '${name}' (valid: ${models.join(', ')})`);
  return model;
}

/**
 * Instances that name `base` in their `use` field (i.e. would break if `base` were removed).
 * @param {object} cfg - the loaded config.
 * @param {string} base - the instance/plugin name.
 * @returns {string[]} - the names of instances that depend on base.
 */
export function dependents(cfg, base) {
  return Object.entries(cfg.agents ?? {})
    .filter(([, entry]) => entry.use === base)
    .map(([name]) => name);
}

/**
 * The instances actually in use for a repo: default + slot overrides + claude (deduped).
 * @param {object} cfg - the loaded config.
 * @param {string} repoDir - the current repo's main-worktree dir.
 * @returns {string[]} - the in-use instance names (claude always included).
 */
export function inUseInstances(cfg, repoDir) {
  const repo = cfg.repos?.[repoDir] ?? {};
  const names = new Set(['claude']);
  if (repo.agent)
    names.add(repo.agent);
  for (const slot of Object.values(repo.slots ?? {})) {
    if (slot.agent)
      names.add(slot.agent);
  }
  return [...names];
}

/**
 * The MCP set to wire for an instance: the standard slot server + declared extras
 * (name-collision -> declared wins).
 * @param {object} cfg - the loaded config.
 * @param {object} _roster - the loaded roster (unused; kept for interface symmetry with callers).
 * @param {string} name - the instance name.
 * @returns {object[]} - the mcp servers to wire for that instance.
 */
export function mcpServersFor(cfg, _roster, name) {
  const slotServer = { name: 'slot-machine', transport: 'stdio', command: join(BIN_DIR, 'slot-machine-mcp') };
  const declared = cfg.agents?.[name]?.mcp ?? [];
  const byName = new Map([[slotServer.name, slotServer]]);
  for (const server of declared)
    byName.set(server.name, server);
  return [...byName.values()];
}

// --- Pure roster mutators: take/return a plain cfg object, no disk IO ---

/** Parse ["K=V", ...] into an env object (only the first '=' splits). */
export function parseEnvPairs(pairs) {
  const env = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq < 0)
      throw new Error(`bad --env '${pair}' (expected KEY=VALUE)`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/** Throw unless `name` is a built-in or a declared instance. */
export function assertAgentKnown(cfg, name) {
  if (name in BUILTINS || (cfg.agents && name in cfg.agents))
    return;
  const known = [...Object.keys(BUILTINS), ...Object.keys(cfg.agents ?? {})];
  throw new Error(`unknown agent '${name}' (known: ${known.join(', ')})`);
}

/** Throw unless `model` is exposed by `name`'s instance (open models accept anything). */
export function assertModelValid(cfg, name, model) {
  if (model == null)
    return;
  const models = modelsOf(cfg, name);
  if (Array.isArray(models) && !models.includes(model))
    throw new Error(`model '${model}' is not exposed by agent '${name}' (valid: ${models.join(', ')})`);
}

/** Set a repo's default agent/model (validated). */
export function setRepoDefault(cfg, repoDir, { agent, model }) {
  cfg.repos ??= {};
  cfg.repos[repoDir] ??= {};
  if (agent != null) {
    assertAgentKnown(cfg, agent);
    cfg.repos[repoDir].agent = agent;
  }
  if (model != null) {
    assertModelValid(cfg, agent ?? cfg.repos[repoDir].agent ?? 'claude', model);
    cfg.repos[repoDir].model = model;
  }
  return cfg;
}

/** Set a per-slot override (validated). */
export function setSlotOverride(cfg, repoDir, label, { agent, model }) {
  cfg.repos ??= {};
  cfg.repos[repoDir] ??= {};
  cfg.repos[repoDir].slots ??= {};
  const name = agent ?? cfg.repos[repoDir].slots[label]?.agent ?? cfg.repos[repoDir].agent ?? 'claude';
  if (agent != null)
    assertAgentKnown(cfg, agent);
  if (model != null)
    assertModelValid(cfg, name, model);
  cfg.repos[repoDir].slots[label] = {
    ...cfg.repos[repoDir].slots[label],
    ...(agent != null ? { agent } : {}),
    ...(model != null ? { model } : {}),
  };
  return cfg;
}

/** Add/replace a roster instance. Rejects shadowing a built-in's code. */
export function addInstance(cfg, name, entry) {
  cfg.agents ??= {};
  const isBuiltin = name in BUILTINS;
  if (isBuiltin && entry.plugin)
    throw new Error(`'${name}' is a reserved built-in - cannot shadow its code with --plugin`);
  if (!isBuiltin && !entry.plugin && !entry.use)
    throw new Error(`'${name}' is not a built-in - pass --use <plugin> or --plugin <path>`);
  const clean = {};
  for (const key of ['use', 'plugin', 'env', 'models', 'defaultModel', 'mcp']) {
    if (entry[key] != null)
      clean[key] = entry[key];
  }
  cfg.agents[name] = clean;
  return cfg;
}

/** Remove a roster instance; refuse if another instance `use`s it. */
export function rmInstance(cfg, name) {
  cfg.agents ??= {};
  if (!(name in cfg.agents))
    throw new Error(`no roster instance '${name}'`);
  const deps = dependents(cfg, name);
  if (deps.length)
    throw new Error(`'${name}' is used by: ${deps.join(', ')} - remove or repoint those first`);
  delete cfg.agents[name];
  return cfg;
}

/** Set the global user-plugin dir. */
export function setAgentsDir(cfg, path) {
  cfg.settings ??= {};
  cfg.settings.agentsDir = path;
  return cfg;
}

// --- IO layer: load plugins and resolve a live instance ---

let cache = null;

// Resolve one roster entry to a plugin object (dynamic import for `plugin`, lookup for `use`/built-in).
async function loadPlugin(cfg, name, entry) {
  if (entry?.plugin) {
    const raw = expandHome(entry.plugin);
    const abs = isAbsolute(raw) ? raw : resolve(agentsDir(cfg), raw);
    const mod = await import(pathToFileURL(abs).href);
    return mod.default;
  }
  const base = entry?.use ?? name;
  if (BUILTINS[base])
    return BUILTINS[base];
  // `use` names another user entry - resolve that entry's plugin.
  const baseEntry = cfg.agents?.[base];
  if (baseEntry?.plugin)
    return loadPlugin(cfg, base, baseEntry);
  throw new Error(`agent '${name}': unknown base '${base}'`);
}

/**
 * Load the roster (memoized). Built-ins are always present; user entries are imported and
 * broken ones recorded in problems and omitted. Call once per command before resolveInstance.
 * @returns {Promise<{instances: Map, problems: string[]}>} - the memoized roster.
 */
export async function loadRoster() {
  if (cache)
    return cache;
  const cfg = loadConfig();
  const instances = new Map();
  const problems = [];
  for (const [name, plugin] of Object.entries(BUILTINS))
    instances.set(name, { name, plugin, env: {}, models: plugin.models, defaultModel: plugin.defaultModel });
  for (const [name, entry] of Object.entries(cfg.agents ?? {})) {
    try {
      const plugin = await loadPlugin(cfg, name, entry);
      instances.set(name, {
        name,
        plugin,
        env: expandEnv(entry.env),
        models: entry.models ?? plugin.models,
        defaultModel: entry.defaultModel ?? plugin.defaultModel,
      });
    }
    catch (err) {
      problems.push(`agent '${name}' skipped: ${err.message}`);
    }
  }
  // Snapshot the cfg used to build the roster so resolveInstance resolves against the SAME
  // config the plugins were loaded from (no re-read, no roster/config drift in watch loops).
  cache = { instances, problems, cfg };
  return cache;
}

/** Clear the memoized roster (test-only). */
export function resetRosterForTest() {
  cache = null;
}

/**
 * Resolve a slot to a concrete { name, plugin, model, env }. Requires loadRoster() already awaited.
 * @param {string} repoDir - the current repo's main-worktree dir.
 * @param {string} label - the slot label.
 * @returns {{name: string, plugin: object, model: string|null, env: object}} - the resolved instance.
 */
export function resolveInstance(repoDir, label) {
  if (!cache)
    throw new Error('resolveInstance called before loadRoster');
  const cfg = cache.cfg; // the same snapshot loadRoster built from - consistent with instances
  const { name } = resolveEntry(cfg, repoDir, label);
  const inst = cache.instances.get(name);
  if (!inst)
    throw new Error(`agent '${name}' is not loaded (see: sm agents ls)`);
  const model = resolveModel(cfg, repoDir, label, name);
  return { name, plugin: inst.plugin, model, env: inst.env };
}

/**
 * The shell command to type into a slot's pane: resolve the instance, decide resume from
 * canResume, and build the launch string. Requires loadRoster() already awaited.
 * @param {string} repoDir - the current repo's main-worktree dir.
 * @param {string} label - the slot label.
 * @param {string} dir - the slot worktree absolute path.
 * @returns {string} - the shell command to type into the slot's pane.
 */
export function launchLine(repoDir, label, dir) {
  const { plugin, model, env } = resolveInstance(repoDir, label);
  const resume = callOp(plugin, 'canResume', { dir, env });
  const canResume = resume.ok ? resume.value : false;
  const launched = callOp(plugin, 'launch', { dir, model, resume: canResume, env });
  if (!launched.ok)
    throw new Error(`launch failed for agent '${plugin.name}': ${launched.detail}`);
  return launched.value;
}

/**
 * The activity of a slot pane via its resolved plugin, unwrapped. ok:false -> a settled,
 * non-'working' label so busy-detection treats it as done. Requires loadRoster() awaited.
 * @param {string} repoDir - the current repo's main-worktree dir.
 * @param {string} label - the slot label.
 * @param {string} capture - the captured pane text.
 * @param {boolean} hasPane - whether the slot has a live pane.
 * @returns {string} 'working' | 'waiting' | 'idle' | 'no-pane' | 'error'
 */
export function activityOf(repoDir, label, capture, hasPane) {
  let plugin, env;
  try {
    ({ plugin, env } = resolveInstance(repoDir, label));
  }
  catch {
    return 'error'; // dead/unloaded instance -> settled, non-'working'; never crashes the read path
  }
  const res = callOp(plugin, 'activity', { capture, hasPane, env });
  return res.ok ? res.value : 'error';
}

/**
 * launchLine, but degraded: returns null (and warns) instead of throwing when the slot's
 * instance cannot be resolved/launched, so the caller leaves that pane at its shell rather
 * than aborting the whole session build.
 * @param {string} repoDir - the current repo's main-worktree dir.
 * @param {string} label - the slot label.
 * @param {string} dir - the slot worktree absolute path.
 * @returns {string|null} - the shell command, or null if the instance could not be resolved/launched.
 */
export function safeLaunchLine(repoDir, label, dir) {
  try {
    return launchLine(repoDir, label, dir);
  }
  catch (err) {
    console.error(`slot ${label}: ${err.message} - pane left at a shell (see: sm agents ls)`);
    return null;
  }
}
