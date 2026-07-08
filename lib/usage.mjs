// Usage recording: every `sm` (or shim) invocation appends one JSONL line so `sm stats` can show
// which commands are used, how often they fail, and how long they take (optimization targets).
// Local-only telemetry - one file, no network, no args/message content recorded.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';

function usageFile() {
  return process.env.SLOT_USAGE_FILE || join(homedir(), '.config', 'slot', 'usage.jsonl');
}

// entry: { cmd, ok, ms, repo, tty }. Stamps ts. Never throws (telemetry must not break the CLI).
export function recordUsage(entry) {
  try {
    const p = usageFile();
    mkdirSync(join(p, '..'), { recursive: true });
    appendFileSync(p, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch {
    /* ignore */
  }
}

export function readUsage() {
  const p = usageFile();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function clearUsage() {
  const p = usageFile();
  if (existsSync(p)) writeFileSync(p, '');
}

// Aggregate entries -> per-command rows sorted by count desc:
// { cmd, count, errors, tty, avgMs, maxMs, lastTs }. Pure (unit-tested).
export function summarizeUsage(entries) {
  const by = new Map();
  for (const e of entries) {
    if (!e.cmd) continue;
    const r = by.get(e.cmd) || { cmd: e.cmd, count: 0, errors: 0, tty: 0, totalMs: 0, maxMs: 0, lastTs: 0 };
    r.count++;
    if (e.ok === false) r.errors++;
    if (e.tty) r.tty++;
    if (Number.isFinite(e.ms)) {
      r.totalMs += e.ms;
      r.maxMs = Math.max(r.maxMs, e.ms);
    }
    r.lastTs = Math.max(r.lastTs, e.ts || 0);
    by.set(e.cmd, r);
  }
  return [...by.values()]
    .map(({ totalMs, ...r }) => ({ ...r, avgMs: r.count ? Math.round(totalMs / r.count) : 0 }))
    .sort((a, b) => b.count - a.count);
}
