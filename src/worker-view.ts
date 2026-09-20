// Adapted from wassname/pi-intercom-supervisor's VCC Markdown view; raw history stays in the saved session.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { compile } from "@sting8k/pi-vcc/src/core/summarize.js";

export const MAX_WORKER_VIEW_BYTES = 8_000;
const RECALL = /\n*-*\n*Use `vcc_recall`[\s\S]*$/;

export interface WorkerProcess {
	pid: number;
	ppid: number;
	command: string;
	args: string;
}

export interface WorkerViewRuntime {
	connected?: boolean;
	status?: string;
	model?: string;
	contextPct?: number;
	pid?: number;
	processes?: WorkerProcess[];
	processError?: string;
}

export interface WorkerViewCursor {
	sessionFile: string;
	boundary: string;
	through: string;
	turns: number;
	progressKey: string;
	stale: number;
}

export function viewClip(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	return Buffer.from(text).subarray(0, bytes - 32).toString("utf8") + "\n[truncated; see saved session]";
}

function messageRows(entries: SessionEntry[]) {
	const boundary = entries.map(entry => entry.type).lastIndexOf("compaction");
	const boundaryId = boundary < 0 ? "root" : entries[boundary].id;
	const rows = entries.slice(boundary + 1).flatMap(entry => {
		if (entry.type === "message") return [{ id: entry.id, timestamp: entry.timestamp, message: entry.message }];
		if (entry.type === "custom_message" && !entry.customType.startsWith("pi-goals-")) {
			return [{ id: entry.id, timestamp: entry.timestamp, message: { role: "user" as const, content: entry.content, timestamp: Date.parse(entry.timestamp) } }];
		}
		return [];
	});
	return { boundary: boundaryId ?? `compaction-${boundary}`, rows };
}

function cleanCompile(messages: unknown[]): string {
	return compile({ messages }).replace(RECALL, "").trim();
}

function section(summary: string, name: string): string {
	const start = summary.indexOf(`[${name}]`);
	if (start < 0) return "";
	const tail = summary.slice(start);
	const next = tail.slice(1).search(/\n\[[^\]]+\]/);
	const separator = tail.indexOf("\n\n---\n\n");
	const ends = [next < 0 ? -1 : next + 1, separator].filter(index => index > 0);
	return tail.slice(0, ends.length ? Math.min(...ends) : undefined).trim();
}

function compactSummary(summary: string): string {
	if (!summary) return "No new saved turns since the last look.";
	if (Buffer.byteLength(summary) <= 5_500) return summary;
	const head = Buffer.from(summary).subarray(0, 1_800).toString("utf8");
	const tail = Buffer.from(summary).subarray(-3_500).toString("utf8");
	return `${head}\n\n[part of this single saved turn omitted; inspect the saved session for exact content]\n\n${tail}`;
}

function age(timestamp: string | undefined, now = Date.now()): string {
	if (!timestamp) return "unknown";
	const seconds = Math.max(0, Math.round((now - Date.parse(timestamp)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function callsAndResults(rows: ReturnType<typeof messageRows>["rows"]) {
	const calls = new Map<string, { name: string; index: number }>();
	const results = new Set<string>();
	for (const [index, row] of rows.entries()) {
		const message = row.message;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, { name: block.name, index });
		}
		if (message.role === "toolResult") results.add(message.toolCallId);
	}
	return { calls, results };
}

function outstandingCalls(rows: ReturnType<typeof messageRows>["rows"]) {
	const { calls, results } = callsAndResults(rows);
	return [...calls].flatMap(([id, call]) => results.has(id) ? [] : [{ id, name: call.name }]);
}

const CONTROL_RESULTS = new Set(["process", "subagent", "bg_wait", "schedule_task", "manage_scheduled_task"]);
function newResultSummaries(rows: ReturnType<typeof messageRows>["rows"], since: number, through: number): string[] {
	const { calls } = callsAndResults(rows);
	return rows.slice(since, through).flatMap(row => {
		const message = row.message;
		if (message.role !== "toolResult") return [];
		const call = calls.get(message.toolCallId), name = call?.name ?? message.toolName;
		if (!message.isError && call?.index !== undefined && call.index >= since && !CONTROL_RESULTS.has(name)) return [];
		const raw = typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join(" ");
		const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		const outcome = message.isError ? "failed" : "returned";
		return [`${name} ${outcome}${text ? `: ${text.slice(0, 220)}` : ""}`];
	});
}

export function descendantProcesses(rootPid: number): WorkerProcess[] {
	if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || !["darwin", "linux"].includes(process.platform)) return [];
	const stdout = execFileSync("ps", ["-eo", "pid=,ppid=,comm=,args="], { encoding: "utf8" });
	const processes = stdout.trim().split("\n").flatMap(line => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
		const ownSnapshot = match?.[3] === "ps" && match[4].includes("-eo pid=,ppid=,comm=,args=");
		return match && !ownSnapshot ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3], args: match[4] }] : [];
	});
	const descendants: WorkerProcess[] = [];
	const parents = new Set([rootPid]);
	for (;;) {
		const found = processes.filter(item => parents.has(item.ppid) && !parents.has(item.pid));
		if (!found.length) break;
		for (const item of found) { descendants.push(item); parents.add(item.pid); }
	}
	return descendants;
}

export function buildWorkerView(
	entries: SessionEntry[],
	sessionFile: string,
	task: string,
	runtime: WorkerViewRuntime = {},
	previous?: WorkerViewCursor,
	diagnostic = false,
): { text: string; cursor: WorkerViewCursor } {
	const current = messageRows(entries), rows = current.rows;
	const sameHistory = previous?.sessionFile === sessionFile && previous.boundary === current.boundary;
	const anchor = sameHistory && previous.through ? rows.findIndex(row => row.id === previous.through) : -1;
	const since = anchor >= 0 ? anchor + 1 : 0;
	const fresh = rows.slice(since);
	const pending = outstandingCalls(rows);
	const pendingNames = pending.length ? `${pending.slice(0, 8).map(call => call.name).join(", ")}${pending.length > 8 ? ` (+${pending.length - 8} more)` : ""}` : "none";
	const processes = runtime.processes;
	const piChildren = processes?.filter(item => item.command === "pi" || /(?:^|\/)(?:pi|pi-coding-agent)(?:[\s/]|$)/.test(item.args)) ?? [];
	const lastTimestamp = rows.at(-1)?.timestamp;
	const status = runtime.connected === false ? "disconnected" : (runtime.status || (runtime.connected ? "connected" : "saved history only")).slice(0, 120);
	const modelName = runtime.model?.slice(0, 160);
	const model = modelName ? `${modelName}${runtime.contextPct === undefined ? "" : `, ${runtime.contextPct}% context used`}` : "unknown";
	const background = runtime.processError ? `process snapshot unavailable: ${viewClip(runtime.processError, 300)}`
		: processes === undefined ? "process snapshot not available"
		: `${processes.length} child OS process${processes.length === 1 ? "" : "es"}; ${piChildren.length} probable child Pi process${piChildren.length === 1 ? "" : "es"}`;
	let consumed = fresh;
	let text = "";
	let progressKey = previous?.progressKey ?? createHash("sha256").update("").digest("hex");
	let stale = 0;
	for (;;) {
		const through = since + consumed.length;
		const compiled = cleanCompile(consumed.map(row => row.message));
		const summary = compactSummary(compiled);
		const results = newResultSummaries(rows, since, through);
		const visibleSummary = cleanCompile(rows.slice(0, through).map(row => row.message));
		const progress = [section(visibleSummary, "Files And Changes"), section(visibleSummary, "Commits")].filter(Boolean).join("\n\n");
		progressKey = createHash("sha256").update(progress).digest("hex");
		stale = consumed.length && sameHistory && previous?.progressKey === progressKey ? previous.stale + 1 : 0;
		const remaining = fresh.length - consumed.length;
		const lines = [
			"## Worker view",
			`Task: ${task.replace(/\s+/g, " ").trim().slice(0, 400) || "unknown"}`,
			`Status: ${status}; last saved activity ${age(lastTimestamp)} ago`,
			`Model: ${model}`,
			`Background: ${background}; unanswered tool calls: ${pendingNames}`,
			...(stale ? [`Progress: no new file or commit for ${stale} view${stale === 1 ? "" : "s"} with new turns`] : []),
			"",
			"### VCC summary of new turns",
			summary,
			...(results.length ? ["", "### New result summaries", ...results.map(result => `- ${result}`)] : []),
			...(remaining ? ["", `${remaining} newer saved turn${remaining === 1 ? "" : "s"} remain; call worker_view again.`] : []),
		];
		if (diagnostic) {
			lines.push("", "### Diagnostics", `Saved session: ${sessionFile}`, `Summary through entry: ${consumed.at(-1)?.id ?? previous?.through ?? "none"}`, `Latest saved entry: ${entries.at(-1)?.id ?? "unknown"}`,
				`Unanswered calls: ${pending.length ? `${pending.slice(0, 8).map(call => `${call.name} (${call.id})`).join(", ")}${pending.length > 8 ? ` (+${pending.length - 8} more)` : ""}` : "none"}`,
				`Child processes: ${processes?.length ? processes.slice(0, 8).map(item => `${item.pid} ${item.command} ${viewClip(item.args, 120)}`).join("; ") : runtime.processError || "none observed"}`,
				"Detached queues and jobs are not inferred from the process tree; check their native owner when the saved turns name one.");
		}
		text = lines.join("\n");
		if (consumed.length <= 1 || Buffer.byteLength(compiled) <= 5_500 && Buffer.byteLength(text) <= MAX_WORKER_VIEW_BYTES) break;
		consumed = fresh.slice(0, Math.max(1, Math.floor(consumed.length / 2)));
	}
	text = viewClip(text, MAX_WORKER_VIEW_BYTES);
	const through = consumed.at(-1)?.id ?? (sameHistory ? previous?.through : "") ?? "";
	return { text, cursor: { sessionFile, boundary: current.boundary, through, turns: since + consumed.length, progressKey, stale } };
}
