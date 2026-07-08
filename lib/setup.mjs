// First-run setup: detect + install the pieces sm needs outside the repo - bin symlinks
// on PATH and (with lib/tmuxconf.mjs) the tmux pane-title block. Detection lives in
// `sm doctor`; `sm doctor --fix` applies what is safely automatable.
import { homedir } from 'node:os';
import { mkdirSync, symlinkSync, unlinkSync, lstatSync, readlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const BIN_DIR = join(homedir(), '.local', 'bin');
export const BINS = ['sm', 'slot-machine', 'slot-machine-mcp']; // mirrors package.json "bin"

// Status of one expected symlink: ok | wrong (points elsewhere) | occupied (a real file
// we will never clobber) | missing.
export function linkStatus(name) {
  const link = join(BIN_DIR, name);
  const target = join(PKG_ROOT, 'bin', name);
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return { name, link, target, status: 'missing' };
  }
  if (!st.isSymbolicLink()) return { name, link, target, status: 'occupied' };
  return { name, link, target, status: readlinkSync(link) === target ? 'ok' : 'wrong' };
}

// Create or re-point the symlink (missing/wrong only). Returns the resulting status.
export function fixLink(s) {
  if (s.status === 'ok' || s.status === 'occupied') return s.status;
  mkdirSync(BIN_DIR, { recursive: true });
  if (s.status === 'wrong') unlinkSync(s.link);
  symlinkSync(s.target, s.link);
  return 'fixed';
}

export const binDirOnPath = () => (process.env.PATH || '').split(':').includes(BIN_DIR);
