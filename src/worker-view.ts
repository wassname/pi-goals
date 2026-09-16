// Adapted from wassname/pi-intercom-supervisor's view.ts: compiler-only, no worker runtime.

import { inspect } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { compile } from "@sting8k/pi-vcc/src/core/summarize.js";
import { workerViewCall, workerViewContent, workerViewText } from "./prompts.js";

export const MAX_WORKER_VIEW_BYTES = 12_000;
// Bound input as well as output. Full arguments/results remain in the linked saved session.
export function viewClip(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	return Buffer.from(text).subarray(0, bytes - 32).toString("utf8") + "\n[truncated; see history]";
}
const preview = (value: unknown, bytes: number) => viewClip(inspect(value, { depth: 3, maxArrayLength: 5, maxStringLength: 200, breakLength: Infinity, compact: true }), bytes);
// Reserve an omission notice; retain whole blocks newest-first, then restore chronology.
function fitBlocks(blocks: string[], bytes: number): string {
	const complete = blocks.join("\n\n");
	if (Buffer.byteLength(complete) <= bytes) return complete;
	const selected: string[] = [];
	let remaining = bytes - Buffer.byteLength(workerViewText.omitted) - 2;
	for (const block of [...blocks].reverse()) {
		const size = Buffer.byteLength(block) + 2;
		if (size > remaining) continue;
		selected.unshift(block); remaining -= size;
	}
	return [selected.length < blocks.length ? workerViewText.omitted : "", ...selected].filter(Boolean).join("\n\n");
}
const controls = new Set(["subagent", "process", "bg_wait", "schedule_task", "manage_scheduled_task", "ReportGoalEvent"]);

export function buildWorkerView(entries: SessionEntry[], sessionFile: string, task: string, presence = workerViewText.unverified): string {
	const boundary = entries.map(entry => entry.type).lastIndexOf("compaction");
	const checkpoint = entries[boundary];
	const rows = entries.flatMap((entry, index) => entry.type === "message" ? [{ id: entry.id, index, message: entry.message }]
		: entry.type === "custom_message" && !entry.customType.startsWith("pi-goals-") ? [{ id: entry.id, index, message: { role: "user" as const, content: entry.content, timestamp: Date.parse(entry.timestamp) } }] : []);
	const kept = checkpoint?.type === "compaction" ? entries.findIndex(entry => entry.id === checkpoint.firstKeptEntryId) : 0;
	const fresh = rows.filter(row => row.index >= (kept < 0 ? boundary : kept)).slice(-40).map(({ message }) => {
		if (message.role === "bashExecution") return { role: message.role, command: viewClip(message.command, 2000), output: viewClip(message.output, 4000) };
		if (!("content" in message)) return { role: message.role };
		const content = typeof message.content === "string" ? viewClip(message.content, 4000) : message.content.filter(block => block.type === "text" || block.type === "toolCall").slice(-8).map(block =>
			block.type === "text" ? { type: block.type, text: viewClip(block.text, 4000) }
				: { type: block.type, id: block.id, name: block.name, arguments: Object.fromEntries(Object.entries(block.arguments).slice(0, 16).map(([key, value]) => [key, typeof value === "string" ? viewClip(value, 2000) : value && typeof value === "object" ? preview(value, 1000) : value])) }); // No raw reasoning or image payloads.
		return { role: message.role, content, ...(message.role === "toolResult" ? { toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError } : {}) };
	});
	// Keep the prior summary separate: the reference documents VCC's headerless merge loss.
	let budget = 32_000;
	const bounded = fresh.reverse().filter(message => { const size = Buffer.byteLength(JSON.stringify(message)); if (size > budget) return false; budget -= size; return true; }).reverse();
	let compiled = compile({ messages: bounded });
	const recall = compiled.lastIndexOf("\n\n---\n\nUse `vcc_recall`");
	if (recall >= 0) compiled = compiled.slice(0, recall);

	type Row = typeof rows[number];
	type Call = { id: string; name: string; args: unknown; row: Row };
	const calls = new Map<string, Call>(), results = new Map<string, Row>();
	for (const row of rows) {
		const message = row.message;
		if (message.role === "assistant") for (const block of message.content) {
			if (block.type === "toolCall") calls.set(block.id, { id: block.id, name: block.name, args: block.arguments, row });
		}
		if (message.role === "toolResult") results.set(message.toolCallId, row);
	}
	const ordered = [...calls.values()].sort((a, b) => Math.max(a.row.index, results.get(a.id)?.index ?? -1) - Math.max(b.row.index, results.get(b.id)?.index ?? -1));
	const render = (call: Call) => {
		const result = results.get(call.id), message = result?.message;
		const body = message?.role === "toolResult" ? preview({ content: message.content.filter(block => block.type === "text"), details: message.details }, 700) : workerViewText.noResult;
		return workerViewCall(viewClip(call.name, 100), preview(call.args, 500), body, viewClip(call.row.id, 100), result && viewClip(result.id, 100), message?.role === "toolResult" && message.isError);
	};
	const recent = ordered.slice(-6);
	// Historical hints, not a job registry: a returned launch is not proof that work finished.
	const earlierControls = ordered.filter(call => controls.has(call.name) && !recent.includes(call)).slice(-3);
	const errors = rows.flatMap(row => row.message.role === "assistant" && row.message.errorMessage ? [`${row.id}: ${row.message.errorMessage}`] : []).slice(-3);
	const view = {
		sessionFile: viewClip(sessionFile, 1000), task: viewClip(task, 400), presence: viewClip(presence, 400), through: viewClip(entries.at(-1)?.id ?? "unknown", 100),
		observed: viewClip(entries.at(-1)?.timestamp ?? "unknown", 100), unmatched: [...calls.keys()].filter(id => !results.has(id)).length,
		recent: "",
		controls: "",
		errors: viewClip(errors.join("\n"), 800),
		earlier: checkpoint?.type === "compaction" ? viewClip(checkpoint.summary, 1000) : "",
		compiled: Buffer.byteLength(compiled) <= 1600 ? compiled : `${viewClip(compiled, 500)}\n${Buffer.from(compiled).subarray(-1000).toString("utf8")}`,
	};
	// Prose excerpts are quoted by the formatter. Never byte-cut assembled Markdown.
	if (Buffer.byteLength(workerViewContent(view)) > MAX_WORKER_VIEW_BYTES - 6000) {
		view.earlier = ""; view.compiled = workerViewText.omitted;
	}
	const available = () => MAX_WORKER_VIEW_BYTES - Buffer.byteLength(workerViewContent(view));
	view.recent = fitBlocks(recent.map(render), Math.min(6000, available() - (earlierControls.length ? 200 : 0)));
	// Allow for the optional section heading as well as its complete blocks.
	view.controls = fitBlocks(earlierControls.map(render), Math.min(1600, available() - 100));
	return workerViewContent(view);
}
