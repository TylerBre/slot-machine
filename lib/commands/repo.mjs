// repo namespace: current-repo selection and the known-repo registry.
import { resolve } from 'node:path';

import { defaultBranch, deriveContext, loadConfig, mainWorktree, saveConfig } from '../context.mjs';
import {
  clr,
  die,
  emitJson,
} from '../format.mjs';
import { setRepoDefault } from '../agents/index.mjs';
import { REPO_DIR } from '../constants.mjs';

import { argOptions, parseCmd } from './shared.mjs';

/**
 * repo ls: the known repos, current marked.
 * @param {string[]} argv - CLI arguments for the repo ls command.
 */
export function cmdRepoLs(argv) {
  const { values } = parseCmd('ls', argv, argOptions('repo-ls'));
  const cfg = loadConfig();
  if (values.json) {
    emitJson({ current: cfg.current || null, repos: cfg.repos || {} });
    return;
  }
  if (!cfg.current)
    console.log('no current repo - set one with: sm repo use <repo>');
  for (const [dir, repo] of Object.entries(cfg.repos || {})) {
    const mark = dir === cfg.current ? clr.green('*') : ' ';
    console.log(
      `${mark} ${clr.bold(repo.name)}  ${dir}  (prefix ${repo.prefix}, session ${repo.sessionPrefix}, base ${repo.baseBranch})`,
    );
  }
}

/**
 * repo inspect [REPO]: one repo's resolved context (the current repo by default).
 * @param {string[]} argv - CLI arguments for the repo inspect command.
 */
export function cmdRepoInspect(argv) {
  const { values, positionals } = parseCmd('inspect', argv, argOptions('repo-inspect'));
  const cfg = loadConfig();
  const key = positionals[0] ? mainWorktree(resolve(positionals[0])) || resolve(positionals[0]) : cfg.current;
  if (!key)
    die('inspect: no current repo - run: sm repo use <repo>');
  const repo = cfg.repos?.[key];
  if (!repo)
    die(`inspect: unknown repo ${key} (sm repo ls shows known repos)`);
  if (values.json) {
    emitJson({ repoDir: key, current: key === cfg.current, ...repo });
    return;
  }
  console.log(`${clr.bold(repo.name)}  ${key}${key === cfg.current ? clr.green('  (current)') : ''}`);
  console.log(`  root     ${repo.root}`);
  console.log(`  prefix   ${repo.prefix}`);
  console.log(`  session  ${repo.sessionPrefix}*`);
  console.log(`  base     ${repo.baseBranch}`);
}

/**
 * repo rm REPO: forget a repo (config only - nothing on disk is touched).
 * @param {string[]} argv - CLI arguments for the repo rm command.
 */
export function cmdRepoRm(argv) {
  const { values, positionals } = parseCmd('rm', argv, argOptions('repo-rm'));
  if (!positionals.length)
    die('rm: name a repo to forget, e.g. sm repo rm ~/code/acme');
  const cfg = loadConfig();
  const repos = cfg.repos || {};
  const arg = positionals[0];
  const asPath = mainWorktree(resolve(arg)) || resolve(arg);
  const key = repos[asPath] ? asPath : Object.keys(repos).filter(dir => repos[dir].name === arg)[0];
  if (!key || !repos[key])
    die(`rm: unknown repo '${arg}' (sm repo ls shows known repos)`);
  const wasCurrent = cfg.current === key;
  delete cfg.repos[key];
  if (wasCurrent)
    cfg.current = null;
  saveConfig(cfg);
  if (values.json) {
    emitJson({ repoDir: key, removed: true, currentCleared: wasCurrent });
    return;
  }
  console.log(
    `forgot ${clr.bold(key)} (config only - nothing on disk touched)${wasCurrent ? ' - no current repo now' : ''}`,
  );
}

/**
 * use REPO: set the current repo and record its derived context in config.
 * @param {string[]} argv - CLI arguments for the use command.
 */
export function cmdUse(argv) {
  const { values, positionals } = parseCmd('use', argv, argOptions('repo-use'));
  if (!positionals.length)
    die('use: name a repo, e.g. sm repo use ~/code/acme  (sm repo ls shows known repos)');

  const cfg = loadConfig();
  const main = mainWorktree(resolve(positionals[0]));
  if (!main)
    die(`use: not a git repository: ${positionals[0]}`);
  const ctx = deriveContext(main, {
    prefix: values.prefix,
    sessionPrefix: values.session,
    baseBranch: values.base,
  });
  if (!values.base)
    ctx.baseBranch = defaultBranch(main);
  cfg.repos ||= {};
  cfg.repos[main] = {
    name: ctx.name,
    root: ctx.root,
    prefix: ctx.prefix,
    sessionPrefix: ctx.sessionPrefix,
    baseBranch: ctx.baseBranch,
  };
  cfg.current = main;
  saveConfig(cfg);
  if (values.json) {
    emitJson({ current: main, ...cfg.repos[main] });
    return;
  }
  console.log(`using ${clr.bold(ctx.name)}  ${main}`);
  console.log(`  root ${ctx.root}  prefix ${ctx.prefix}  session ${ctx.sessionPrefix}*  base ${ctx.baseBranch}`);
}

/**
 * repo config [--agent NAME] [--model M]: set the current repo's default agent instance/model.
 * @param {string[]} argv - CLI arguments for the config command.
 */
export function cmdRepoConfig(argv) {
  const { values } = parseCmd('config', argv, argOptions('repo-config'));
  const cfg = loadConfig();
  try {
    setRepoDefault(cfg, REPO_DIR, { agent: values.agent, model: values.model });
  }
  catch (err) {
    die(`config: ${err.message}`);
  }
  saveConfig(cfg);
  if (values.json) {
    emitJson({ repo: REPO_DIR, agent: cfg.repos[REPO_DIR].agent, model: cfg.repos[REPO_DIR].model });
    return;
  }
  console.log(`${clr.bold(REPO_DIR)}: agent=${cfg.repos[REPO_DIR].agent ?? 'claude'} model=${cfg.repos[REPO_DIR].model ?? '(default)'}`);
}
