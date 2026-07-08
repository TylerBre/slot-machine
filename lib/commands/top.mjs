// top-level namespace: environment health check (doctor) and usage stats.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE_BRANCH,
  configReport,
  DOCS,
  PREFIX,
  REPO_DIR,
  REPO_NAME,
} from '../constants.mjs';
import { CONFIG_ERROR } from '../context.mjs';
import {
  agoStr,
  clr,
  emitJson,
  startSpinner,
} from '../format.mjs';
import {
  listSlots,
  pexec,
  repoSlug,
  run,
  tmux,
  tmuxOut,
} from '../exec.mjs';

import { clearUsage, readUsage, summarizeUsage } from '../usage.mjs';
import { TMUX_SETTINGS, tmuxTitlesStatus, writeTmuxBlock } from '../tmuxconf.mjs';
import { BIN_DIR, binDirOnPath, BINS, fixLink, linkStatus, PKG_ROOT } from '../setup.mjs';
import { argOptions, parseCmd } from './shared.mjs';

/**
 * stats: per-command usage from the local usage log - what gets used, what fails, what's slow.
 * @param {string[]} argv - CLI arguments for the stats command.
 */
export function cmdStats(argv) {
  const { values } = parseCmd('stats', argv, argOptions('stats'));
  let entries = readUsage();
  const total = entries.length;
  if (values.days) {
    const cutoff = Date.now() - (parseInt(values.days, 10) || 0) * 86_400_000;
    entries = entries.filter(entry => (entry.ts || 0) >= cutoff);
  }
  const rows = summarizeUsage(entries);
  if (values.json) {
    emitJson(rows);
  }
  else if (!rows.length) {
    console.log('stats: no usage recorded yet');
  }
  else {
    const width = Math.max(8, ...rows.map(row => row.cmd.length));
    console.log(
      clr.dim(
        `${'command'.padEnd(width)}  ${'count'.padStart(5)}  ${'errs'.padStart(4)}  ${'tty'.padStart(4)}  ${'avg ms'.padStart(7)}  ${'max ms'.padStart(7)}  last used`,
      ),
    );
    for (const row of rows) {
      const last = row.lastTs ? agoStr(row.lastTs) : '-';
      const errs = row.errors ? clr.red(String(row.errors).padStart(4)) : '   0';
      console.log(
        `${clr.bold(row.cmd.padEnd(width))}  ${String(row.count).padStart(5)}  ${errs}  ${String(row.tty).padStart(4)}  ${String(row.avgMs).padStart(7)}  ${String(row.maxMs).padStart(7)}  ${clr.dim(last)}`,
      );
    }
    console.log(
      clr.dim(
        `\n${entries.length} invocation(s)${values.days ? ` in the last ${values.days}d (of ${total} total)` : ''}`,
      ),
    );
  }
  if (values.clear)
    clearUsage();
}

/**
 * doctor: check that the environment + config are healthy for slot to work.
 * @param {string[]} argv - CLI arguments for the doctor command.
 */
export async function cmdDoctor(argv) {
  const { values } = parseCmd('doctor', argv, argOptions('doctor'));
  const fix = values.fix;
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  const ver = async (cmd, args) => (await run(cmd, args)).trim().split('\n')[0];
  const stopSpin = values.json ? () => {} : startSpinner('running checks...');

  const tmuxV = await ver('tmux', ['-V']);
  add('tmux', tmuxV ? 'ok' : 'fail', tmuxV || 'not found on PATH');

  // --fix / --fix-tmux: upsert sm's pane-title block into the user's tmux.conf, apply it
  // to a running server, then fall through so the normal checks verify the result.
  if (fix || values['fix-tmux']) {
    const { path, changed } = writeTmuxBlock();
    if (tmuxV) {
      for (const [opt, val] of TMUX_SETTINGS) tmux(['set', '-g', opt, val]);
    }
    add(
      'tmux config',
      'ok',
      changed ? `wrote pane-title block to ${path}` : `block already present in ${path}`,
    );
  }
  // Pane titles: with N worker panes, the border title is how you tell them apart.
  const titles = tmuxTitlesStatus((tmuxOut(['show-options', '-gv', 'pane-border-status']) ?? '').trim());
  add(
    'tmux pane titles',
    titles.ok ? 'ok' : 'warn',
    titles.ok
      ? `pane-border-status ${titles.value} (${titles.source})`
      : 'off - worker panes are hard to tell apart; fix: sm doctor --fix',
  );
  const gitV = await ver('git', ['--version']);
  add('git', gitV ? 'ok' : 'fail', gitV || 'not found on PATH');
  const ghV = await ver('gh', ['--version']);
  add('gh', ghV ? 'ok' : 'warn', ghV || 'not found - PR state unavailable, slots may misclassify');
  add('node', 'ok', process.version);
  const claudeV = await ver('claude', ['--version']);
  add(
    'claude',
    claudeV ? 'ok' : 'warn',
    claudeV || 'not found - worker panes will have nothing to run (install Claude Code)',
  );
  if (ghV) {
    const authed = await pexec('gh', ['auth', 'status'])
      .then(() => true)
      .catch(() => false);
    add(
      'gh auth',
      authed ? 'ok' : 'warn',
      authed ? 'authenticated' : 'not logged in (gh auth login) - PR state unavailable',
    );
  }

  // Bin symlinks in ~/.local/bin (--fix creates/repairs; never clobbers a real file).
  const links = BINS.map(linkStatus);
  if (fix) {
    for (const link of links) {
      if (fixLink(link) === 'fixed') {
        link.status = 'ok';
        link.fixed = true;
      }
    }
  }
  const badLinks = links.filter(link => link.status !== 'ok');
  add(
    'bin links',
    badLinks.length ? 'warn' : 'ok',
    badLinks.length
      ? `${badLinks.map(link => `${link.name}: ${link.status}`).join(', ')} - fix: sm doctor --fix`
      : `${BINS.join(', ')} -> ${join(PKG_ROOT, 'bin')}${links.some(link => link.fixed) ? ' (installed)' : ''}`,
  );
  add(
    'PATH',
    binDirOnPath() ? 'ok' : 'warn',
    binDirOnPath() ? `${BIN_DIR} is on PATH` : `${BIN_DIR} is not on PATH - add it in your shell rc`,
  );

  // MCP registration with Claude Code ('slot' tolerated as an older registration name).
  if (claudeV) {
    const reg = mcpName =>
      pexec('claude', ['mcp', 'get', mcpName])
        .then(() => mcpName)
        .catch(() => null);
    let name = (await reg('slot-machine')) || (await reg('slot'));
    if (!name && fix) {
      const added = await pexec('claude', [
        'mcp',
        'add',
        'slot-machine',
        '-s',
        'user',
        '--',
        join(BIN_DIR, 'slot-machine-mcp'),
      ])
        .then(() => true)
        .catch(() => false);
      if (added)
        name = 'slot-machine (registered)';
    }
    add('mcp server', name ? 'ok' : 'warn', name || 'not registered with Claude Code - fix: sm doctor --fix');
  }

  const cfg = configReport();
  add('config file', cfg.fileOk ? 'ok' : 'ok', cfg.fileOk ? cfg.path : 'none yet');
  // doctor is config-tolerant (the router lets it run despite a bad config), so it is the place
  // that surfaces the problem: a set CONFIG_ERROR is a failed check, not a silent pass.
  if (CONFIG_ERROR)
    add('config', 'fail', CONFIG_ERROR);
  add(
    'repo',
    REPO_DIR ? 'ok' : 'warn',
    REPO_DIR ? `${REPO_NAME}  ${REPO_DIR}` : 'none set - run: sm repo use <repo>',
  );
  if (cfg.values) {
    for (const [key, val] of Object.entries(cfg.values)) add(`  ${key}`, 'ok', String(val));
  }

  if (REPO_DIR) {
    const rootOk = existsSync(DOCS);
    add('root dir', rootOk ? 'ok' : 'fail', rootOk ? DOCS : `${DOCS} missing`);
    const slots = rootOk ? listSlots() : [];
    add(
      'slots',
      slots.length ? 'ok' : 'warn',
      slots.length
        ? `${slots.length}: ${slots.map(name => name.slice(PREFIX.length)).join(',')}`
        : `no ${PREFIX}* worktrees in ${DOCS}`,
    );
    if (slots.length) {
      const dir = join(DOCS, slots[0]);
      const slug = await repoSlug(dir);
      add('origin remote', slug ? 'ok' : 'warn', slug || 'no origin remote - gh PR lookups will fail');
      const baseOk = await pexec('git', ['-C', dir, 'rev-parse', '--verify', `origin/${BASE_BRANCH}`])
        .then(() => true)
        .catch(() => false);
      add(
        `base origin/${BASE_BRANCH}`,
        baseOk ? 'ok' : 'warn',
        baseOk ? 'resolvable' : `not found - run: git -C <slot> fetch origin ${BASE_BRANCH}`,
      );
    }
  }

  stopSpin();
  const fails = checks.filter(check => check.level === 'fail').length;
  const warns = checks.filter(check => check.level === 'warn').length;
  if (values.json) {
    emitJson({ ok: fails === 0, fails, warns, checks });
    if (fails)
      process.exitCode = 1;
    return;
  }
  const mark = { ok: clr.green('ok  '), warn: clr.yellow('warn'), fail: clr.red('fail') };
  const width = Math.max(...checks.map(check => check.name.length));
  for (const check of checks) console.log(`  ${mark[check.level]}  ${check.name.padEnd(width)}  ${clr.dim(check.detail)}`);
  console.log(
    `\n${fails ? clr.red(`${fails} problem(s)`) : clr.green('healthy')}${warns ? clr.yellow(`, ${warns} warning(s)`) : ''}`,
  );
  if (fails)
    process.exit(1);
}
