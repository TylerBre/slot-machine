// The built-in Claude Code plugin: launch string, resume check, activity regexes, transcript
// parsing, watch-hook delivery. Parameterized by the instance's env (pre-expanded by the registry).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ERR, err, ok } from './contract.mjs';

const DEFAULT_DIR = join(homedir(), '.claude');

// The Claude config dir for an instance: CLAUDE_CONFIG_DIR (env is pre-expanded) else ~/.claude.
const configDir = env => (env && env.CLAUDE_CONFIG_DIR) || DEFAULT_DIR;

/**
 * The Claude project/transcript dir for a worktree under this instance's config dir.
 * Matches the original slug rule (join(configDir, 'projects', dir with / and . -> -)).
 * @param {string} dir - absolute worktree path.
 * @param {object} env - the instance env (pre-expanded).
 * @returns {string} - the transcript directory path.
 */
export const transcriptDir = (dir, env) => join(configDir(env), 'projects', dir.replace(/[/.]/g, '-'));

// Single-quote a value for a shell env prefix; safe for spaces and shell metachars.
const shq = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const envPrefix = env => Object.entries(env || {}).map(([key, val]) => `${key}=${shq(val)} `).join('');

// --- delivery capability (optional op pair; an agent without it has no delivery layer) ---
// Watch delivery = Stop + UserPromptSubmit hooks in the DESK PROJECT's settings, never
// user-level. Commands are repo-pinned: an unpinned one gates against the globally mutable
// current-repo pointer, so `sm repo use` anywhere would silently repoint every desk's hooks.
// Dedup is by exact command string (Claude Code's own merge rule); setup upgrades bare -> pinned.
const HOOK_TYPES = { Stop: 'stop', UserPromptSubmit: 'prompt-submit' };
const bareHookCommand = event => `sm watch --check --ack --hook ${HOOK_TYPES[event]}`;
const pinnedHookCommand = (event, repoDir) => `sm watch --repo ${repoDir} --check --ack --hook ${HOOK_TYPES[event]}`;
const deskSettingsPath = deskDir => join(deskDir, '.claude', 'settings.json');

function deliveryWired(deskDir, repoDir) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(deskSettingsPath(deskDir), 'utf8'));
  }
  catch {
    return { stop: false, promptSubmit: false, unpinned: [] };
  }
  const commandsFor = event => (settings.hooks?.[event] ?? [])
    .flatMap(matcher => (matcher.hooks ?? []).map(hook => hook.command));
  const state = (event) => {
    const commands = commandsFor(event);
    if (repoDir && commands.includes(pinnedHookCommand(event, repoDir)))
      return 'pinned';
    if (commands.includes(bareHookCommand(event)))
      return 'bare';
    return 'absent';
  };
  const stop = state('Stop');
  const promptSubmit = state('UserPromptSubmit');
  return {
    stop: stop !== 'absent',
    promptSubmit: promptSubmit !== 'absent',
    unpinned: [stop === 'bare' ? 'Stop' : null, promptSubmit === 'bare' ? 'UserPromptSubmit' : null].filter(Boolean),
  };
}

// Newest *.jsonl under a transcript dir, or null.
function newestTranscript(root) {
  let files;
  try {
    files = readdirSync(root).filter(file => file.endsWith('.jsonl'));
  }
  catch {
    return null;
  }
  if (!files.length)
    return null;
  return files
    .map(file => [join(root, file), statSync(join(root, file)).mtimeMs])
    .sort((left, right) => right[1] - left[1])[0];
}

export default {
  name: 'claude',
  models: '*', // Claude Code validates its own --model; accept any string
  defaultModel: null, // emit no --model flag by default

  launch({ dir: _dir, model, resume, env }) {
    const modelFlag = model ? ` --model ${model}` : '';
    const cmd = resume ? `claude -c${modelFlag}` : `claude${modelFlag}`;
    return ok(`${envPrefix(env)}${cmd}`);
  },

  canResume({ dir, env }) {
    try {
      return ok(readdirSync(transcriptDir(dir, env)).some(file => file.endsWith('.jsonl')));
    }
    catch {
      return ok(false);
    }
  },

  activity({ capture, hasPane }) {
    if (!hasPane)
      return ok('no-pane');
    if (/esc to interrupt|· ↓|· ↑|tokens\)/.test(capture))
      return ok('working');
    if (/Do you want|❯ \d\.|Would you like to proceed|Allow this/.test(capture))
      return ok('waiting');
    return ok('idle');
  },

  lastMessage({ dir, env }) {
    const newest = newestTranscript(transcriptDir(dir, env));
    if (!newest)
      return ok(null);
    let text = null;
    try {
      for (const line of readFileSync(newest[0], 'utf8').split('\n')) {
        if (!line)
          continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        }
        catch {
          continue;
        }
        if (parsed.type === 'assistant') {
          for (const block of parsed.message?.content || []) {
            if (block && block.type === 'text' && block.text && block.text.trim())
              text = block.text.trim();
          }
        }
      }
    }
    catch {
      return ok(null);
    }
    return ok(text);
  },

  transcriptAge({ dir, env }) {
    const newest = newestTranscript(transcriptDir(dir, env));
    if (!newest || !existsSync(newest[0]))
      return ok(null);
    return ok(Math.floor((Date.now() - newest[1]) / 1000));
  },

  doctor({ env, mcpServers, deskDir, repoDir }) {
    const childEnv = { ...process.env, ...(env || {}) };
    const verResult = spawnSync('claude', ['--version'], { encoding: 'utf8', env: childEnv });
    if (verResult.status !== 0)
      return err(ERR.NOT_INSTALLED, 'claude not found on PATH');
    const version = (verResult.stdout || '').trim().split('\n')[0];
    const mcp = (mcpServers || []).map((server) => {
      const getResult = spawnSync('claude', ['mcp', 'get', server.name], { encoding: 'utf8', env: childEnv });
      return { name: server.name, wired: getResult.status === 0 };
    });
    // Delivery status is additive: reported only when the caller passes deskDir.
    return ok(deskDir ? { version, mcp, delivery: deliveryWired(deskDir, repoDir) } : { version, mcp });
  },

  deliverySetup({ deskDir, repoDir }) {
    if (!deskDir)
      return err(ERR.CONFIG, 'deliverySetup needs deskDir (the fleet root the desk runs in)');
    if (!repoDir)
      return err(ERR.CONFIG, 'deliverySetup needs repoDir (the repo the hooks are pinned to)');
    const path = deskSettingsPath(deskDir);
    let settings = {};
    if (existsSync(path)) {
      try {
        settings = JSON.parse(readFileSync(path, 'utf8'));
      }
      catch {
        // Never rewrite what we cannot faithfully read - clobbering eats the user's own hooks/permissions.
        return err(ERR.UNPARSEABLE, `${path} is not valid JSON - refusing to rewrite it`);
      }
    }
    settings.hooks ??= {};
    const installed = [];
    const upgraded = [];
    for (const event of Object.keys(HOOK_TYPES)) {
      const pinned = pinnedHookCommand(event, repoDir);
      const bare = bareHookCommand(event);
      const matchers = settings.hooks[event] ??= [];
      const hooksOf = matchers.flatMap(matcher => matcher.hooks ?? []);
      if (hooksOf.some(hook => hook.command === pinned))
        continue; // idempotent: dedup by exact command string
      const bareHook = hooksOf.find(hook => hook.command === bare);
      if (bareHook) {
        bareHook.command = pinned; // upgrade a pre-pin install in place, never duplicate
        upgraded.push(event);
        continue;
      }
      matchers.push({ matcher: '*', hooks: [{ type: 'command', command: pinned, timeout: 30 }] });
      installed.push(event);
    }
    if (installed.length || upgraded.length) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
    }
    return ok({ installed, upgraded, path, changed: installed.length + upgraded.length > 0 });
  },

  setup({ mcpServers, env }) {
    const childEnv = { ...process.env, ...(env || {}) };
    const wired = [];
    for (const server of mcpServers || []) {
      // url-based (sse/http) servers use --transport <t> <name> <url>; command (stdio) servers
      // use the `-- command args` form. Guard against building `... -- undefined`.
      let args;
      if (server.url)
        args = ['mcp', 'add', '--transport', server.transport || 'sse', '-s', 'user', server.name, server.url];
      else if (server.command)
        args = ['mcp', 'add', server.name, '-s', 'user', '--', server.command, ...(server.args || [])];
      else
        continue; // malformed server spec: neither command nor url
      const addResult = spawnSync('claude', args, { encoding: 'utf8', env: childEnv });
      if (addResult.status === 0)
        wired.push(server.name);
    }
    return ok({ wired });
  },
};
