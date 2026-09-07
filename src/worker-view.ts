export interface SessionBlock {
	type?: string;
	id?: string;
	name?: string;
	text?: string;
}

export interface SessionMessage {
	role?: string;
	content?: string | SessionBlock[];
	toolCallId?: string;
}

export interface SessionEntry {
	type?: string;
	summary?: string;
	message?: SessionMessage;
}

function text(message: SessionMessage): string {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? []).flatMap((block) => {
		if (block.type === "text" && block.text) return [block.text];
		if (block.type === "toolCall") return [`tool: ${block.name ?? "unknown"}`];
		return [];
	}).join("\n");
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

export function workerView(entries: SessionEntry[], reason: "ready" | "settled" | "turns" | "interval"): string {
	const summary = [...entries].reverse().find((entry) => entry.type === "compaction" && entry.summary)?.summary;
	const recent = entries.flatMap((entry) => entry.type === "message" && entry.message ? [text(entry.message)] : []).filter(Boolean).slice(-12).join("\n\n").slice(-12_000);
	const outstanding = outstandingTools(entries);
	const state = reason === "settled" ? "stopped" : reason === "ready" ? "is ready to begin" : "is still working";
	return `The worker ${state}.\n\nreview trigger: ${reason}\ntool calls with no result: ${outstanding.join(", ") || "none"}\n\n${summary ? `last compaction summary:\n${summary}\n\n` : ""}recent worker transcript:\n${recent || "none"}`;
}
