// Usage recording: every `sm` (or shim) invocation appends one JSONL line so `sm stats` can show
// which commands are used, how often they fail, and how long they take (optimization targets).
// Local-only telemetry - one file, no network, no args/message content recorded.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadSchema, validate } from './schema.mjs';
import { elevate } from './elevators.mjs';

function usageFile() {
  return process.env.SLOT_USAGE_FILE || join(homedir(), '.config', 'slot', 'usage.jsonl');
}

const USAGE_SCHEMA = loadSchema('usage-record.schema.json');
const USAGE_SCHEMA_VERSION = USAGE_SCHEMA.properties.v.const;
// v0 (legacy, no `v`) -> v1: stamp version. Spread first so the stamped `v` is authoritative
// (a stray `v` on the raw record must not survive - matches the inbox elevator's guarantee).
const USAGE_ELEVATORS = [
  raw => ({ ...raw, v: 1 }),
];

/**
 * entry: { cmd, ok, ms, repo, tty }. Stamps v + ts. Never throws (telemetry must not break the CLI).
 * @param {object} entry - The usage entry to record: { cmd, ok, ms, repo, tty }.
 */
export function recordUsage(entry) {
  try {
    const filePath = usageFile();
    mkdirSync(join(filePath, '..'), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify({ v: USAGE_SCHEMA_VERSION, ts: Date.now(), ...entry })}\n`);
  }
  catch {
    /* ignore */
  }
}

/**
 * Read all recorded usage entries from the usage file. Elevates legacy (v0) lines and validates
 * each one against USAGE_SCHEMA, silently skipping anything invalid - telemetry must not throw.
 * @returns {object[]} Parsed usage entries (empty if the file is absent).
 */
export function readUsage() {
  const filePath = usageFile();
  if (!existsSync(filePath))
    return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const record = elevate(JSON.parse(line), USAGE_ELEVATORS, USAGE_SCHEMA_VERSION);
        return validate(record, USAGE_SCHEMA).length ? null : record;
      }
      catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Clear the usage file by truncating it if it exists.
 */
export function clearUsage() {
  const filePath = usageFile();
  if (existsSync(filePath))
    writeFileSync(filePath, '');
}

/**
 * Aggregate entries -> per-command rows sorted by count desc:
 * { cmd, count, errors, tty, avgMs, maxMs, lastTs }. Pure (unit-tested).
 * @param {object[]} entries - Raw usage entries to aggregate.
 * @returns {object[]} Per-command summary rows sorted by count descending.
 */
export function summarizeUsage(entries) {
  const by = new Map();
  for (const entry of entries) {
    if (!entry.cmd)
      continue;
    const row = by.get(entry.cmd) || { cmd: entry.cmd, count: 0, errors: 0, tty: 0, totalMs: 0, maxMs: 0, lastTs: 0 };
    row.count++;
    if (entry.ok === false)
      row.errors++;
    if (entry.tty)
      row.tty++;
    if (Number.isFinite(entry.ms)) {
      row.totalMs += entry.ms;
      row.maxMs = Math.max(row.maxMs, entry.ms);
    }
    row.lastTs = Math.max(row.lastTs, entry.ts || 0);
    by.set(entry.cmd, row);
  }
  return [...by.values()]
    .map(({ totalMs, ...rest }) => ({ ...rest, avgMs: rest.count ? Math.round(totalMs / rest.count) : 0 }))
    .sort((left, right) => right.count - left.count);
}
