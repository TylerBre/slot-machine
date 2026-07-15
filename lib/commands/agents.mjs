// agents namespace: manage the global roster (plugins + instances). CLI-only; global (no repo).
import { readFileSync } from 'node:fs';
import { loadConfig, saveConfig } from '../context.mjs';
import { clr, die, emitJson } from '../format.mjs';
import { addInstance, agentsDir, loadRoster, parseEnvPairs, rmInstance, setAgentsDir } from '../agents/index.mjs';
import { argOptions, parseCmd } from './shared.mjs';

/**
 * agents ls: the roster + load status.
 * @param {string[]} argv - CLI arguments for the ls command.
 */
export async function cmdAgentsLs(argv) {
  const { values } = parseCmd('ls', argv, argOptions('agents-ls'));
  const cfg = loadConfig();
  const roster = await loadRoster();
  const rows = [...roster.instances.keys()].map((name) => {
    const entry = cfg.agents?.[name] ?? {};
    const base = entry.plugin ? `plugin:${entry.plugin}` : (entry.use ?? name);
    return { name, base, models: roster.instances.get(name).models, source: cfg.agents?.[name] ? 'user' : 'built-in' };
  });
  if (values.json) {
    emitJson({ agents: rows, problems: roster.problems });
    return;
  }
  for (const row of rows)
    console.log(`${clr.bold(row.name)}  ${clr.dim(row.base)}  models=${Array.isArray(row.models) ? row.models.join(',') : row.models}  ${clr.dim(row.source)}`);
  for (const problem of roster.problems)
    console.log(clr.yellow(`! ${problem}`));
}

/**
 * agents dir [PATH]: set/show the global user-plugin dir.
 * @param {string[]} argv - CLI arguments for the dir command.
 */
export function cmdAgentsDir(argv) {
  const { values, positionals } = parseCmd('dir', argv, argOptions('agents-dir'));
  const cfg = loadConfig();
  if (!positionals.length) {
    if (values.json)
      emitJson({ agentsDir: agentsDir(cfg) });
    else console.log(agentsDir(cfg));
    return;
  }
  setAgentsDir(cfg, positionals[0]);
  saveConfig(cfg);
  if (values.json)
    emitJson({ agentsDir: cfg.settings.agentsDir });
  else console.log(`agents dir: ${cfg.settings.agentsDir}`);
}

/**
 * agents add NAME [--use|--plugin ...].
 * @param {string[]} argv - CLI arguments for the add command.
 */
export function cmdAgentsAdd(argv) {
  const { values, positionals } = parseCmd('add', argv, argOptions('agents-add'));
  if (!positionals.length)
    die('add: name the instance, e.g. sm agents add enterprise-claude --use claude --env CLAUDE_CONFIG_DIR=~/.claude-work');
  const cfg = loadConfig();
  try {
    // Build the entry INSIDE the try: parseEnvPairs throws on a bad KEY=VALUE, and
    // readFileSync/JSON.parse throw on a missing/invalid --mcp file - all must route to die().
    const entry = {
      use: values.use,
      plugin: values.plugin,
      env: values.env ? parseEnvPairs(values.env) : undefined,
      models: values.models ? values.models.split(',') : undefined,
      defaultModel: values['default-model'],
      mcp: values.mcp ? JSON.parse(readFileSync(values.mcp, 'utf8')) : undefined,
    };
    addInstance(cfg, positionals[0], entry);
  }
  catch (err) {
    die(`add: ${err.message}`);
  }
  saveConfig(cfg);
  if (values.json)
    emitJson({ added: positionals[0], entry: cfg.agents[positionals[0]] });
  else console.log(`added instance ${clr.bold(positionals[0])}`);
}

/**
 * agents rm NAME.
 * @param {string[]} argv - CLI arguments for the rm command.
 */
export function cmdAgentsRm(argv) {
  const { values, positionals } = parseCmd('rm', argv, argOptions('agents-rm'));
  if (!positionals.length)
    die('rm: name the instance to remove');
  const cfg = loadConfig();
  try {
    rmInstance(cfg, positionals[0]);
  }
  catch (err) {
    die(`rm: ${err.message}`);
  }
  saveConfig(cfg);
  if (values.json)
    emitJson({ removed: positionals[0] });
  else console.log(`removed instance ${clr.bold(positionals[0])}`);
}
