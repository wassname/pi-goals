// Pi/OpenAI: Sum recorded requests, not context occupancy; do not read message text.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function readSession(file) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const tail = lines.pop();
  let trailingPartial = false;
  if (tail) {
    try { JSON.parse(tail); lines.push(tail); }
    catch { trailingPartial = true; }
  }
  return { file: resolve(file), sha256: createHash('sha256').update(raw).digest('hex'), trailingPartial,
    entries: lines.filter(Boolean).map(JSON.parse) };
}

export function summarize(entries, since, until) {
  const start = Date.parse(since), end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Invalid time interval');
  const rows = entries.filter(e => e.type === 'message' && e.message.role === 'assistant' && Date.parse(e.timestamp) >= start && Date.parse(e.timestamp) <= end);
  const totals = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 };
  const models = new Map();
  let missingUsage = 0;
  for (const e of rows) {
    const m = e.message;
    if (!m.usage) { missingUsage++; continue; }
    const model = `${m.provider}/${m.model}`;
    if (!models.has(model)) models.set(model, { model, ...totals, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 });
    const group = models.get(model);
    totals.calls++; group.calls++;
    for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'totalTokens']) {
      const value = m.usage[key];
      if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid usage.${key} in entry ${e.id}`);
      totals[key] += value; group[key] += value;
    }
  }
  return { ...totals, missingUsage, firstRequest: rows[0]?.timestamp ?? null,
    lastRequest: rows.at(-1)?.timestamp ?? null, models: [...models.values()] };
}

export function report(supervisor, worker, until = new Date().toISOString()) {
  const boundary = supervisor.entries.findLast(e => e.type === 'custom' && e.customType === 'pi-goals-main-supervisor-v1' && e.data.mode === 'planning' && !e.data.child);
  if (!boundary) throw new Error('No recorded planning start in supervisor session');
  const since = boundary.timestamp;
  const sessions = [supervisor, worker].map((session, i) => ({
    role: i === 0 ? 'supervisor' : 'worker', file: session.file, sha256: session.sha256,
    trailingPartial: session.trailingPartial, ...summarize(session.entries, since, until),
  }));
  return { since, until, elapsedHours: (Date.parse(until) - Date.parse(since)) / 3600000,
    boundaryEntry: boundary.id, plan: boundary.data.plan, sessions,
    scope: 'Recorded assistant usage since latest planning entry, including abandoned branches and repeated cached context. Excludes earlier inherited history, in-flight requests, subprocess API usage and unrecorded compaction calls. Output includes reasoning where the provider includes it; reasoning is not added twice.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [supervisor, worker] = process.argv.slice(2);
  if (!supervisor || !worker || process.argv.length !== 4) throw new Error('Usage: node scripts/session-usage.mjs SUPERVISOR.jsonl WORKER.jsonl');
  console.log(JSON.stringify(report(readSession(supervisor), readSession(worker)), null, 2));
}
