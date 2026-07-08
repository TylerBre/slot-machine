// First-run setup: detect + install the pieces sm needs outside the repo - bin symlinks
// on PATH and (with lib/tmuxconf.mjs) the tmux pane-title block. Detection lives in
// `sm doctor`; `sm doctor --fix` applies what is safely automatable.
import { homedir } from 'node:os';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const BIN_DIR = join(homedir(), '.local', 'bin');
export const BINS = ['sm', 'slot-machine', 'slot-machine-mcp']; // mirrors package.json "bin"

/**
 * Status of one expected symlink: ok | wrong (points elsewhere) | occupied (a real file
 * we will never clobber) | missing.
 * @param {string} name - The bin name to check.
 * @returns {{name: string, link: string, target: string, status: string}} The link status entry.
 */
export function linkStatus(name) {
  const link = join(BIN_DIR, name);
  const target = join(PKG_ROOT, 'bin', name);
  let st;
  try {
    st = lstatSync(link);
  }
  catch {
    return { name, link, target, status: 'missing' };
  }
  if (!st.isSymbolicLink())
    return { name, link, target, status: 'occupied' };
  return { name, link, target, status: readlinkSync(link) === target ? 'ok' : 'wrong' };
}

/**
 * Create or re-point the symlink (missing/wrong only). Returns the resulting status.
 * @param {{name: string, link: string, target: string, status: string}} entry - A link status entry from linkStatus.
 * @returns {string} The resulting status.
 */
export function fixLink(entry) {
  if (entry.status === 'ok' || entry.status === 'occupied')
    return entry.status;
  mkdirSync(BIN_DIR, { recursive: true });
  if (entry.status === 'wrong')
    unlinkSync(entry.link);
  symlinkSync(entry.target, entry.link);
  return 'fixed';
}

/**
 * Whether BIN_DIR is currently on PATH.
 * @returns {boolean} True when BIN_DIR is listed in the PATH environment variable.
 */
export const binDirOnPath = () => (process.env.PATH || '').split(':').includes(BIN_DIR);
