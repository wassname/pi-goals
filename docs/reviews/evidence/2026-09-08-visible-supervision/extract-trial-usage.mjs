#!/usr/bin/env node
// Bounded trial accounting only. Reads explicitly named Pi session JSONL files, not RPC event logs.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function session(path) {
  const rows = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (rows[0]?.type !== "session") throw new Error(`Not a Pi session JSONL file: ${path}`);
  const byId = new Map();
  for (const row of rows.slice(1)) if (typeof row.id === "string") byId.set(row.id, row);
  return { header: rows[0], entries: [...byId.values()] }; // Replayed/replaced records count once by entry ID.
}

function snapshot(workerFile, manifestFile) {
  const path = resolve(workerFile);
  const worker = session(path);
  const manifest = { workerFile: path, workerSessionId: worker.header.id, startMs: Date.now(), baselineIds: worker.entries.map(entry => entry.id) };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { manifestFile: resolve(manifestFile), workerSessionId: worker.header.id, startMs: manifest.startMs, note: "Snapshot taken before Ready. Keep worker idle until Ready; do not overwrite this boundary." };
}

const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const empty = () => ({ entries: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, missingUsageEntries: [], missingFields: {}, recordedPositiveCostSubtotal: 0, zeroOrMissingCostEntries: [] });
function add(totals, entry, usage) {
  totals.entries++; // Persisted accounting entries, including listed missing-usage entries; not provider calls.
  if (!usage) { totals.missingUsageEntries.push(entry.id); return; }
  for (const field of fields) {
    if (Number.isFinite(usage[field]) && usage[field] >= 0) totals[field] += usage[field];
    else totals.missingFields[field] = (totals.missingFields[field] ?? 0) + 1;
  }
  if (Number.isFinite(usage.cost?.total) && usage.cost.total > 0) totals.recordedPositiveCostSubtotal += usage.cost.total;
  else totals.zeroOrMissingCostEntries.push(entry.id);
}

function roleUsage(path, baseline, endMs, role) {
  const data = session(path);
  const inherited = new Set(baseline.baselineIds);
  const marker = role === "supervisor" ? data.entries.findIndex(entry => entry.type === "custom" && entry.customType === "pi-goals-supervisor" && resolve(entry.data?.binding?.workerSession ?? "/missing") === baseline.workerFile) : -1;
  if (role === "supervisor" && marker < 0) throw new Error("No matching native supervisor bootstrap marker: refusing to count inherited planning usage as supervisor work");
  const total = empty(); const assistant = empty(); const compaction = empty(); const nestedTools = empty();
  const models = new Set(); const compactions = []; const entriesCounted = []; const missingTimestamps = [];
  let selectedModel = null; let completionToolResults = 0;
  data.entries.forEach((entry, index) => {
    if (entry.type === "model_change") selectedModel = `${entry.provider}/${entry.modelId}`;
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.provider && entry.message.model) selectedModel = `${entry.message.provider}/${entry.message.model}`;
    if (index <= marker || inherited.has(entry.id)) return;
    const time = Date.parse(entry.timestamp);
    if (!Number.isFinite(time)) { missingTimestamps.push(entry.id); return; }
    if (time < baseline.startMs || time > endMs) return;
    let category; let usage;
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason !== "pending") {
      category = assistant; usage = entry.message.usage;
      models.add(`${entry.message.provider ?? "unknown"}/${entry.message.model ?? "unknown"}`);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      category = compaction; usage = entry.usage;
      compactions.push({ entryId: entry.id, type: entry.type, timestamp: entry.timestamp, selectedModel, modelAttribution: "selected model inferred from preceding session entries; a custom summarizer may use another model", tokensBefore: entry.tokensBefore ?? null, hasUsage: Boolean(usage) });
    } else if (entry.type === "message" && entry.message?.role === "toolResult") {
      if (entry.message.toolName === "CompleteGoal") completionToolResults++;
      if (entry.message.usage) { category = nestedTools; usage = entry.message.usage; }
    }
    if (!category) return;
    add(category, entry, usage); add(total, entry, usage); entriesCounted.push(entry.id);
  });
  return { role, sessionFile: resolve(path), sessionId: data.header.id, reportedAssistantModels: [...models], totalRecordedUsage: total, assistant, compaction, nestedTools, compactions, entriesCounted, excludedUnknownTimestampEntries: missingTimestamps, completionToolResults,
    cost: total.zeroOrMissingCostEntries.length || total.missingUsageEntries.length ? "unavailable/incomplete: zero or missing pricing is not proof of zero cost" : "recorded positive costs only; not independently verified pricing",
    compactionCoverage: "All post-boundary compaction/branch-summary usage is included when persisted. Missing entries are listed, not assumed free. Session records do not explicitly label initial versus later compaction; inspect the timestamp/marker sequence." };
}

const [command, first, second, out] = process.argv.slice(2);
let result;
if (command === "start" && first && second) result = snapshot(first, second);
else if (command === "finish" && first && second) {
  const baseline = JSON.parse(readFileSync(first, "utf8"));
  const worker = session(baseline.workerFile);
  if (worker.header.id !== baseline.workerSessionId) throw new Error("Worker session identity changed since the boundary");
  const endMs = Date.now();
  result = { startMs: baseline.startMs, endMs,
    worker: roleUsage(baseline.workerFile, baseline, endMs, "worker"), supervisor: roleUsage(resolve(second), baseline, endMs, "supervisor"),
    currentContext: "These are cumulative recorded token metrics, NOT current context. The >100k compaction trigger uses ctx.getContextUsage().tokens. Native compaction tokensBefore is reported separately above.",
    freshEvidenceJudge: { status: "instrumentation gap", explanation: "Current CompleteGoal runs a fresh pi -p --no-session judge and saves its text receipt, not provider Usage. Completion tool result counts do not establish judge invocation counts or tokens. Report judge tokens/cost unavailable unless separately instrumented in an authorized trial; do not hide this overhead in worker/supervisor totals." },
    limitations: ["Wait for both trial sessions to settle/stop before finish so no partial JSONL/provider usage is mistaken for completed work.", "Inherited pre-fork history is excluded using both the worker baseline ID set and the supervisor bootstrap marker.", "No RPC message_update/message_end events are counted; duplicate persisted entry IDs are counted once.", "The entries counters are persisted accounting-entry counts, not provider-call counts. Native split-turn compaction may combine multiple calls in one entry, as may aggregated nested-tool usage. Entries with missing usage are counted and listed separately.", "Tool-result nested usage is separate. Do not add it again from another session without proving it is disjoint.", "Long complete VCC refreshes are ordinary supervisor calls and therefore included in supervisor usage, not assumed free."] };
} else throw new Error("Usage: node extract-trial-usage.mjs start WORKER_SESSION.jsonl BOUNDARY.json | finish BOUNDARY.json SUPERVISOR_SESSION.jsonl [USAGE_OUTPUT.json]");
const text = `${JSON.stringify(result, null, 2)}\n`;
if (command === "finish" && out) writeFileSync(out, text, { flag: "wx", mode: 0o600 });
process.stdout.write(text);
