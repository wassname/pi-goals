import { compile } from "@sting8k/pi-vcc/src/core/summarize";
import { type SupervisorReviewReason, supervisorCheckIn } from "./prompts.js";

export interface SessionBlock {
	type?: string;
	id?: string;
	name?: string;
	text?: string;
	thinking?: string;
	arguments?: Record<string, unknown>;
}

export interface SessionMessage {
	role?: string;
	content?: string | SessionBlock[];
	toolCallId?: string;
	toolName?: string;
}

export interface SessionEntry {
	id?: string;
	type?: string;
	summary?: string;
	message?: SessionMessage;
}

// VCC drops reasoning. Preserve only two recent tails, in place beside the actions they inform.
function recentThinking(messages: SessionMessage[]): SessionMessage[] {
	let remaining = 2;
	return messages.map(message => ({
		...message,
		// Unanswered/partial calls may have no arguments yet; VCC expects an argument object.
		content: Array.isArray(message.content) ? message.content.map(block => block.type === "toolCall" ? { ...block, arguments: block.arguments ?? {} } : { ...block }) : message.content,
	})).reverse().map(message => {
		if (Array.isArray(message.content)) {
			for (const block of [...message.content].reverse()) {
				if (block.type === "thinking" && block.thinking && remaining > 0) {
					block.type = "text";
					block.text = `(thinking) ${block.thinking.slice(-400)}`;
					remaining--;
				}
			}
		}
		return message;
	}).reverse();
}

function compiledView(messages: SessionMessage[]): string {
	// Only role/content/tool fields are read by normalize; Pi usage/provider metadata is irrelevant.
	const compiled = compile({ messages: recentThinking(messages) as Parameters<typeof compile>[0]["messages"] })
		.replace(/\n*-*\n*Use `vcc_recall`[\s\S]*$/, "").trim();
	const separator = compiled.indexOf("\n\n---\n\n");
	// Keep extracted context and newest actions separately: a long brief must not evict all headers.
	if (/^\[(Session Goal|Files And Changes|Commits|Outstanding Context|User Preferences)\]/.test(compiled)) {
		if (separator < 0) return bounded(compiled, 1500);
		return `${bounded(compiled.slice(0, separator), 1500)}\n\n${bounded(compiled.slice(separator + 7), 4000, true)}`;
	}
	return bounded(compiled || (messages.length ? "No overview text retained from these messages." : "No new messages."), 5500, true);
}

function outstandingTools(entries: SessionEntry[]): string[] {
	const calls = new Map<string, string>();
	const results = new Set<string>();
	for (const entry of entries) {
		for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
			if (block.type === "toolCall" && block.id) calls.set(block.id, block.name ?? "unknown");
		}
		if (entry.message?.role === "toolResult" && entry.message.toolCallId) results.add(entry.message.toolCallId);
	}
	return [...calls].filter(([id]) => !results.has(id)).map(([, name]) => name);
}

function bounded(value: string, bytes: number, tail = false): string {
	if (Buffer.byteLength(JSON.stringify(value)) <= bytes) return value;
	let size = Math.min(value.length, bytes - 100);
	while (Buffer.byteLength(JSON.stringify(tail ? value.slice(-size) : value.slice(0, size))) > bytes - 100) size = Math.floor(size * 0.8);
	const notice = "[truncated; inspect source session]";
	return tail ? `${notice}\n${value.slice(-size)}` : `${value.slice(0, size)}\n${notice}`;
}

export interface ViewContext {
	sourceSession: string;
	latestDirection: string;
	model: string;
	contextPercent?: number | null;
	since?: string;
	background: string;
	planReview?: string;
}

export function workerView(entries: SessionEntry[], reason: SupervisorReviewReason, idle: boolean, context: ViewContext): string {
	const compactAt = entries.map(entry => entry.type).lastIndexOf("compaction");
	const since = context.since ? entries.findIndex(entry => entry.id === context.since) : -1;
	const from = since >= compactAt ? since + 1 : compactAt + 1;
	const fresh = entries.slice(from);
	const recent = compiledView(fresh.flatMap(entry => entry.type === "message" && entry.message ? [entry.message] : []));
	const summary = since < compactAt ? entries[compactAt]?.summary : undefined;
	const outstanding = outstandingTools(entries.slice(compactAt + 1));
	return `${supervisorCheckIn(reason, idle)}\n\nreview trigger: ${reason}\nsource session: ${bounded(context.sourceSession, 800)}\nworker model: ${bounded(context.model, 300)}${context.contextPercent == null ? "" : `; context used: ${context.contextPercent}%`}\nlatest human direction:\n${bounded(context.latestDirection || "not recorded", 1800)}\ntool calls with no result: ${bounded(outstanding.join(", ") || "none", 500)}\ntracked background work: ${bounded(context.background, 800)}\n\n${context.planReview ? `Plan review:\n${bounded(context.planReview, 1800)}\n\n` : ""}${summary ? `compaction summary (worker account, not independent evidence):\n${bounded(summary, 2500)}\n\n` : ""}new worker overview${since === -1 ? " (initial or reset view)" : " since the last acknowledged view"} (VCC algorithmic compression; local # refs index new messages; tool-result bodies omitted; inspect source for evidence):\n${recent}`;
}
