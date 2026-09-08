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
	id?: string;
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
	since?: string;
	background: string;
}

export function workerView(entries: SessionEntry[], reason: "ready" | "settled" | "turns" | "interval" | "started", idle: boolean, context: ViewContext): string {
	const compactAt = entries.map(entry => entry.type).lastIndexOf("compaction");
	const since = context.since ? entries.findIndex(entry => entry.id === context.since) : -1;
	const from = since >= compactAt ? since + 1 : compactAt + 1;
	const fresh = entries.slice(from);
	const recent = fresh.flatMap(entry => entry.type === "message" && entry.message ? [text(entry.message)] : []).filter(Boolean).join("\n\n");
	const summary = since < compactAt ? entries[compactAt]?.summary : undefined;
	const outstanding = outstandingTools(entries.slice(compactAt + 1));
	const state = reason === "ready" ? "is ready to begin" : idle ? "stopped" : "is still working";
	return `The worker ${state}.\n\nreview trigger: ${reason}\nsource session: ${bounded(context.sourceSession, 800)}\nworker model: ${bounded(context.model, 300)}\nlatest human direction:\n${bounded(context.latestDirection || "not recorded", 1800)}\ntool calls with no result: ${bounded(outstanding.join(", ") || "none", 500)}\ntracked background work: ${bounded(context.background, 800)}\n\n${summary ? `compaction summary (worker account, not independent evidence):\n${bounded(summary, 2500)}\n\n` : ""}new worker transcript${since === -1 ? " (initial or reset view)" : " since the last acknowledged view"}:\n${bounded(recent || "No new messages.", 7000, true)}`;
}
