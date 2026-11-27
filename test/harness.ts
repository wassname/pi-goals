// Fake Pi, scheduler commands and pi-subagents event owner: enough to exercise data flow, not rendering.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RUNTIME_AGENT_REGISTER_EVENT } from "pi-subagents/agents";
import { SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT, SUBAGENT_DELEGATION_STARTED_EVENT } from "pi-subagents/delegation";
import piGoals from "../src/index.js";

export const LOOP = "Custom loop statement written by the user.";
export const GOALS = `# Title

## Goal

A plot. Make the plot.

## Result mock-up

| run | score-placeholder |

## Notes

- could look done but is not: a plot without error bars

## Loop statement

${LOOP}

## Resume here

## Evidence
`;
/** The agent's note, as an edit tool would leave the file. */
export const withNote = (text: string, note: string) => text.replace("## Resume here\n", `## Resume here\n\n${note}\n`);

export type JudgeReply = { status: string; value?: unknown; error?: string } | "silent";

export function setup(opts: { choices?: Array<string | undefined>; judge?: JudgeReply; subagents?: boolean; onRequest?: () => void; autoSchedule?: boolean; autoStart?: boolean; schedulerVersion?: string; schedulerLoaded?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-"));
	const choices = [...(opts.choices ?? [])];
	const scheduler = join(cwd, "scheduler/extensions/scheduler/index.ts");
	mkdirSync(join(cwd, "scheduler/extensions/scheduler"), { recursive: true });
	writeFileSync(join(cwd, "scheduler/package.json"), JSON.stringify({ name: "@jl1990/pi-scheduler", version: opts.schedulerVersion ?? "0.6.0" }));
	const branch: any[] = [];
	const sent: Array<{ text: string; options?: unknown }> = [];
	const notes: string[] = [];
	const shown: Array<{ customType: string; content: string; display: boolean }> = [];
	const requests: any[] = [];
	const agents: any[] = [];
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const hooks = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const events = {
		emit: (channel: string, data: unknown) => { for (const handler of [...(listeners.get(channel) ?? [])]) handler(data); },
		on: (channel: string, handler: (data: unknown) => void) => {
			if (!listeners.has(channel)) listeners.set(channel, new Set());
			listeners.get(channel)!.add(handler);
			return () => listeners.get(channel)!.delete(handler);
		},
	};
	if (opts.subagents !== false) {
		events.on(RUNTIME_AGENT_REGISTER_EVENT, (request: any) => { agents.push(request); request.result = { ok: true, registration: { dispose: () => { request.disposed = true; } } }; });
		events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (request: any) => {
			requests.push(request);
			opts.onRequest?.();
			const reply = opts.judge ?? { status: "completed", value: { verdict: "accept", checks: [{ path: "plot.png", quote: "q", observation: "o" }], missing: "" } };
			if (reply === "silent") return;
			const identity = { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId };
			queueMicrotask(() => {
				events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity);
				events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { ...identity, requestId: "someone-else" });
				events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { ...identity, status: reply.status, error: reply.error, result: reply.value === undefined ? undefined : { kind: "structured", value: reply.value } });
			});
		});
	}
	const ctx: any = {
		cwd,
		hasUI: true,
		mode: "rpc",
		model: { provider: "p", id: "m" },
		sessionManager: { getSessionId: () => "sess", getSessionFile: () => join(cwd, "session.jsonl"), getBranch: () => branch, getEntries: () => branch },
		ui: {
			setStatus: (_key: string, text?: string) => { ctx.status = text; },
			setWidget: (_key: string, lines: unknown) => { ctx.widget = lines; },
			notify: (text: string) => notes.push(text),
			select: async () => choices.shift(),
			editor: async () => undefined,
			getToolsExpanded: () => ctx.toolsExpanded === true,
		},
	};
	let activeTools = ["read", "bash", "TaskCreate", "TaskUpdate"];
	const pi = {
		events,
		getActiveTools: () => [...activeTools],
		getAllTools: () => ["read", "bash", "TaskCreate", "TaskUpdate", ...tools.keys()].map((name) => ({ name })),
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		on: (name: string, handler: any) => hooks.set(name, handler),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (message: (typeof shown)[number]) => shown.push(message),
		sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
		getCommands: () => (opts.schedulerLoaded === false ? [] : ["schedule", "schedule-remove"]).map(name => ({ name, source: "extension", sourceInfo: { path: scheduler } })),
	};
	piGoals(pi as unknown as ExtensionAPI);
	let cursor = 0;
	let nextTask = 0;
	async function flush() {
		while (cursor < sent.length) {
			const message = sent[cursor++];
			if (message.text.startsWith("/schedule ") && opts.autoSchedule !== false) schedulerReceipt(`t${++nextTask}`);
			if (message.text.startsWith("[pi-goals:start-work:") && opts.autoStart !== false) {
				const out = await hooks.get("input")!({ source: "extension", text: message.text }, ctx);
				if (out?.action === "transform") message.text = out.text;
			}
		}
	}
	const hook = async (name: string, event: any = {}) => { const out = await hooks.get(name)!(event, ctx); await flush(); return out; };
	const goalsCommand = commands.get("goals");
	const originalHandler = goalsCommand.handler;
	goalsCommand.handler = async (...args: any[]) => { await originalHandler(...args); await flush(); };
	/** What the stock scheduler records after `/schedule prompt ... :: <marker>`. */
	function schedulerReceipt(id: string) {
		const command = sent.findLast(m => m.text.startsWith("/schedule "))!;
		const prompt = command.text.split(" :: ")[1];
		branch.push({ type: "custom_message", customType: "scheduled-task", details: { task: { id, prompt, action: "prompt", type: "interval", schedule: "1h", enabled: true, status: "pending", scope: "session", sessionFile: ctx.sessionManager.getSessionFile() } } });
		return prompt;
	}
	/** The stock scheduler's wake: its header lines, a blank line, then the stored prompt. */
	const wake = (id: string, prompt: string, schedule = "1h") => hook("input", { source: "extension", text: `[Scheduled task ${id} fired]\nName: (unnamed)\nAction: prompt\nType: interval\nSchedule: ${schedule}\nScheduled for: 2026-01-01T00:00:00.000Z\n\n${prompt}` });
	const complete = () => tools.get("CompleteGoal").execute("call", {}, undefined, undefined, ctx);
	/** The agent stops: Pi's last actionable boundary, with the text of its last message. */
	const settle = (last = "Done for now.", event: Record<string, unknown> = {}) => hook("agent_before_settle", { outcome: "completed", continue: false, entries: [], context: { llmMessages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text: last }] }] }, ...event });
	/** An edit-tool call on a file: the hooks around it, with the write in between. */
	async function edit(path: string, text: string, id = `call-${sent.length}-${Math.random()}`) {
		await hook("tool_call", { toolName: "edit", toolCallId: id, input: { path } });
		writeFileSync(path, text);
		return hook("tool_result", { toolName: "edit", toolCallId: id, content: [{ type: "text", text: "ok" }] });
	}
	/** A shell command that rewrites a file, as agents do with sed or a python one-liner. */
	async function shell(command: string, path: string, text: string, id = `sh-${sent.length}-${Math.random()}`) {
		await hook("tool_call", { toolName: "bash", toolCallId: id, input: { command } });
		writeFileSync(path, text);
		return hook("tool_result", { toolName: "bash", toolCallId: id, content: [{ type: "text", text: "" }] });
	}
	return { activeTools: () => activeTools, branch, commands, complete, ctx, cwd, edit, shell, events, hook, shown, notes, requests, agents, schedulerReceipt, sent, settle, tools, wake, flush, pi };
}
