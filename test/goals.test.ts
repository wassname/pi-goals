import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createEditTool, type ExtensionAPI, SessionManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openProjectPane } from "pi-subagents/project-panes";
import { afterEach, expect, it, vi } from "vitest";
import goalsExtension from "../src/index.js";
import { upkeep, workerAssignment } from "../src/prompts.js";

vi.mock("pi-subagents/project-panes", () => ({ openProjectPane: vi.fn(async () => ({ ok: true, data: { bindingPath: "/project/.pi/subagents/project-pane.json", disposition: "opened", binding: { paneId: "native-pane", projectRoot: "/project", command: "pi" } } })) }));

const roots: string[] = [];
const shutdowns: Array<() => void> = [];
afterEach(() => { for (const shutdown of shutdowns.splice(0)) shutdown(); vi.unstubAllEnvs(); vi.mocked(openProjectPane).mockClear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, ms = 1500): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await delay(10);
	}
}
function fixture(child = false) {
	const cwd = mkdtempSync(join(tmpdir(), "goals-main-test-")); roots.push(cwd);
	const entries: any[] = child ? [{ type: "custom", customType: "pi-goals-main-supervisor-v1", data: { mode: "solo", child: true } }] : []; const hooks = new Map<string, any>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
	const messages: any[] = [];
	const ctx = { cwd, isIdle: vi.fn(() => true), sessionManager: { getBranch: () => entries, getSessionId: () => "copy-only", getSessionFile: () => join(cwd, "session.jsonl"), getLeafId: () => "reviewed-leaf", getHeader: () => ({ id: "copy-only", cwd }) }, hasUI: true, hasPendingMessages: vi.fn(() => false), ui: {
		getEditorText: vi.fn(() => ""), theme: { fg: (_color: string, text: string) => text }, notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), select: vi.fn(async (_title: string, _options: string[]) => "Ready"), editor: vi.fn(),
	} };
	let registration: any;
	const channel = { snapshot: vi.fn(() => ({ connected: true, supported: true })), listSessions: vi.fn(async () => [{ id: "parent-intercom", pid: process.pid }, { id: "live-parent", pid: process.pid + 1 }]), publish: vi.fn() };
	const pi = {
		on: (event: string, hook: any) => hooks.set(event, hook),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerMarkdownTransformer: vi.fn(),
		registerEntryRenderer: vi.fn(),
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
		sendUserMessage: (content: string, options: any) => messages.push({ message: { content }, options, savedPrompt: true }),
		events: { emit: vi.fn((name, data) => { if (name === "intercom:extension-register") { registration = data; data.onReady(channel); } }) },
		getAllTools: vi.fn((): any[] => []),
		getCommands: vi.fn((): any[] => [...commands.keys()].map(name => ({name}))),
	};
	goalsExtension(pi as unknown as ExtensionAPI);
	hooks.get("session_start")({}, ctx);
	let path = "";
	const command = async (value: string) => {
		await commands.get("goals").handler(value, ctx);
		const planDir = join(cwd, ".pi", "plan");
		if (!path && existsSync(planDir)) {
			const firstPlan = readdirSync(planDir).find(name => name.endsWith(".md"));
			if (firstPlan) path = join(planDir, firstPlan);
		}
	};
	const plan = "# Plan\n- [ ] goal: first output\n- [ ] goal: second output\n\n## Log\n";
	const draft = async () => { await command("new two outputs"); writeFileSync(path, plan); };
	const shutdown = () => hooks.get("session_shutdown")();
	shutdowns.push(shutdown);
	const changed = () => messages.filter((m) => m.message?.content?.includes("Plan changed")).length;
	const atomicWrite = async (text: string) => {
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, path);
		await delay(25);
	};
	const start = (_id: string) => hooks.get("tool_call")({ toolName: "OpenGoalWorker" }, ctx);
	const launch = async (details: { id: string; sessionFile: string }) => {
		await tools.get("OpenGoalWorker").execute("open", { task: "Implement first output" }, undefined, undefined, ctx);
		const state = entries.at(-1).data;
		registration.onEvent({ type: "message", fromSessionId: details.id, payload: { type: "attached", to: state.worker.parentId, requestId: state.worker.requestId, plan: state.plan, sessionFile: details.sessionFile } });
	};
	return { ctx, pi, hooks, tools, commands, messages, command, get path() { return path; }, plan, draft, shutdown, changed, atomicWrite, get entries() { return entries.filter(entry => entry.customType === "pi-goals-main-supervisor-v1"); }, start, launch, channel, event: (event: any) => registration.onEvent(event) };
}

it.each([
	["chat", ["new", "attach", "help", "quit"]],
	["planning", ["edit", "discuss", "ready", "model", "help", "quit"]],
	["supervising", ["review", "stop", "model", "help", "quit"]],
	["paused", ["resume", "model", "help", "quit"]],
	["solo", ["stop", "help", "quit"]],
])("shows only applicable %s actions without starting work", async (mode, expected) => {
	const f = fixture();
	if (mode !== "chat") await f.draft();
	if (mode === "supervising" || mode === "paused") await f.command("ready");
	if (mode === "paused") await f.command("stop");
	if (mode === "solo") { f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo"); }
	const before = f.messages.length;
	f.ctx.ui.select.mockResolvedValueOnce(undefined as any);
	await f.command("");
	const actions = f.ctx.ui.select.mock.calls.at(-1)![1];
	expect(actions.map(action => action.split(" — ")[0])).toEqual(expected);
	expect(actions.at(-1)).toBe("quit — Exit and clear goals");
	expect(f.messages).toHaveLength(before);
	expect(f.commands.get("goals").getArgumentCompletions("res")).toEqual([{ value: "resume", label: "resume" }]);
});

it.each(["redy", "start", "two outputs", "status extra", "attach some.md solo extra"])("rejects %s without changing the plan or sending a model prompt", async (text) => {
	const f = fixture(); await f.draft();
	const before = readFileSync(f.path, "utf8");
	const entries = f.entries.length; const messages = f.messages.length;
	await f.command(text);
	expect(readFileSync(f.path, "utf8")).toBe(before);
	expect(f.entries).toHaveLength(entries);
	expect(f.messages).toHaveLength(messages);
});

it("requires a model argument without clearing the preference", async () => {
	const f = fixture(); await f.draft(); await f.command("model provider/model");
	const before = readFileSync(f.path, "utf8");
	await f.command("model");
	expect(readFileSync(f.path, "utf8")).toBe(before);
});

it.each(["menu", "command"])("enters planning conversation through %s without a worker launch", async (route) => {
	const f = fixture();
	f.ctx.ui.select.mockResolvedValueOnce("new — New plan…");
	f.ctx.ui.editor.mockResolvedValueOnce("supplied instructions");
	await f.command(route === "menu" ? "" : "new");
	expect(f.entries.at(-1).data.mode).toBe("planning");
	expect(f.ctx.ui.editor).toHaveBeenCalledTimes(route === "menu" ? 1 : 0);
	expect(f.messages).toHaveLength(1);
	expect(f.messages[0].message.content).toContain(route === "menu" ? "Initial idea: supplied instructions" : "Use the existing conversation");
	expect(f.hooks.get("tool_call")({ toolName: "subagent" }).block).toBe(true);
});

it("cancelled menu New creates nothing and sends nothing", async () => {
	const f = fixture();
	f.ctx.ui.select.mockResolvedValueOnce("new — New plan…");
	await f.command(""); // editor returns undefined on Cancel
	expect(f.entries).toHaveLength(0); expect(f.messages).toHaveLength(0);
	expect(existsSync(join(f.ctx.cwd, ".pi/plan"))).toBe(false);
});

it("new names use six session characters, skip deletion holes and suffix collisions, and preserve old files", async () => {
	const f = fixture(); f.ctx.sessionManager.getSessionId = () => "first-abc123";
	const directory = join(f.ctx.cwd, ".pi/plan"); mkdirSync(directory, { recursive: true });
	const old = ["2026-09-14-000000Z-descriptive-plan-v1.md", "abc123-v1.md", "abc123-v2.md", "abc123-v10.md"];
	for (const name of old) writeFileSync(join(directory, name), name);
	rmSync(join(directory, "abc123-v2.md"));
	await f.command("new Preserve the descriptive title");
	const first = f.entries.at(-1).data.plan;
	expect(basename(first)).toBe("abc123-v11.md");
	expect(readFileSync(first, "utf8")).toContain("# Preserve the descriptive title\n");
	f.ctx.sessionManager.getSessionId = () => "another-abc123";
	await f.command("new Different session with same suffix");
	expect(basename(f.entries.at(-1).data.plan)).toBe("abc123-v12.md");
	expect(readFileSync(first, "utf8")).toContain("# Preserve the descriptive title\n");
	for (const name of old.filter(name => name !== "abc123-v2.md")) expect(readFileSync(join(directory, name), "utf8")).toBe(name);
	expect(readdirSync(directory)).toHaveLength(5);
});

it("edits even an empty draft directly without a model call", async () => {
	const f = fixture(); await f.command("new"); const before = f.messages.length;
	f.ctx.ui.editor.mockResolvedValueOnce(f.plan);
	f.ctx.ui.select.mockResolvedValueOnce("edit — Edit plan…"); await f.command("");
	expect(readFileSync(f.path, "utf8")).toBe(f.plan);
	expect(f.entries.at(-1).data.mode).toBe("planning");
	expect(f.messages).toHaveLength(before);
});

it("clear preserves the plan without a backup, warns for misbound jobs and allows a separate new draft", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.launch({ id: "stale", sessionFile: "/tmp/old-worker.jsonl" });
	const jobs = [
		{ id: "owned", name: "goals-copy-only", action: "prompt", scope: "session", sessionFile: f.ctx.sessionManager.getSessionFile() },
		{ id: "older", name: "older-plan", action: "prompt", scope: "session", sessionFile: f.ctx.sessionManager.getSessionFile() },
		{ id: "foreign", name: "goals-copy-only", action: "prompt", scope: "session", sessionFile: "/other.jsonl" },
		{ id: "unbound", name: "goals-copy-only", action: "prompt", scope: "global" },
	];
	const sourceInfo = { path: fileURLToPath(import.meta.resolve("@jl1990/pi-scheduler/extensions/scheduler/index.ts")) };
	f.pi.getCommands.mockReturnValue([...["schedules", "schedule-remove"].map(name => ({ name, source: "extension", sourceInfo: { path: "/foreign/index.ts" } })), ...["schedules:2", "schedule-remove:2"].map(name => ({ name, source: "extension", sourceInfo }))]);
	const branch = f.ctx.sessionManager.getBranch();
	branch.push({ type: "custom_message", id: "reviewed-leaf", customType: "scheduled-task", details: { includeAll: true, tasks: jobs } });
	writeFileSync(f.ctx.sessionManager.getSessionFile(), "persisted fixture\n");
	const before = f.messages.length; await f.command("clear");
	expect(f.entries.at(-1).data).toEqual({ mode: "chat" });
	expect(f.messages.slice(before)).toEqual([{ message: { content: "/schedules:2 all" }, options: { expandPromptTemplates: true, deliverAs: "followUp" }, savedPrompt: true }]);
	// Passive command results append public entries and persist, without message_end.
	branch.push({ type: "custom_message", id: "fresh-list", customType: "scheduled-task", details: { includeAll: true, tasks: jobs } });
	writeFileSync(f.ctx.sessionManager.getSessionFile(), "new persistence signal\n");
	await waitFor(() => f.messages.length === before + 2);
	expect(f.messages.at(-1)).toMatchObject({ message: { content: "/schedule-remove:2 owned" }, options: { expandPromptTemplates: true } });
	expect(f.messages).toHaveLength(before + 2);
	expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("missing/different session scope"), "warning");
	const wake = (id: string) => ({ source: "extension", text: `[Scheduled task ${id} fired]\nName: goals-copy-only\nAction: prompt\nType: interval\n` });
	expect(f.hooks.get("input")(wake("owned"), f.ctx)).toEqual({ action: "handled" });
	expect(f.hooks.get("input")(wake("foreign"), f.ctx)).toBeUndefined();
	expect(f.hooks.get("input")({ ...wake("owned"), source: "interactive" }, f.ctx)).toBeUndefined();
	const directory = join(f.ctx.cwd, ".pi/plan");
	expect(readdirSync(directory)).toEqual([basename(f.path)]);
	expect(readFileSync(f.path, "utf8")).toBe(f.plan);
	await f.command("new a different objective");
	const next = f.entries.at(-1).data;
	expect(next.mode).toBe("planning"); expect(next.worker).toBeUndefined(); expect(next.plan).not.toBe(f.path);
	expect(readFileSync(next.plan, "utf8")).toContain("a different objective");
	expect(readFileSync(next.plan, "utf8")).not.toContain("first output");
	expect(readFileSync(f.path, "utf8")).toBe(f.plan);
	expect(readdirSync(directory)).toHaveLength(2);
	expect(f.messages).toHaveLength(before + 3); // Two scheduler commands, then New's normal planning turn.
});

it.each(["missing", "timeout", "busy-timeout", "non-agent-busy", "cancelled"])("clear fails closed for %s session observation", async kind => {
	const f = fixture();
	const sourceInfo = { path: fileURLToPath(import.meta.resolve("@jl1990/pi-scheduler/extensions/scheduler/index.ts")) };
	f.pi.getCommands.mockReturnValue(["schedules", "schedule-remove"].map(name => ({ name, source: "extension", sourceInfo })));
	const branch = f.ctx.sessionManager.getBranch();
	branch.push({ type: "custom", id: "reviewed-leaf" });
	if (kind !== "missing") writeFileSync(f.ctx.sessionManager.getSessionFile(), "persisted");
	if (kind === "busy-timeout" || kind === "non-agent-busy") f.ctx.isIdle.mockReturnValue(false);
	vi.useFakeTimers();
	try {
		await f.command("clear");
		if (kind === "busy-timeout") {
			// A run beginning after dispatch must suspend the already-armed deadline.
			f.hooks.get("agent_start")({}, f.ctx);
			await vi.advanceTimersByTimeAsync(6_000);
			expect(f.ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("removal unconfirmed"), "warning");
			f.ctx.isIdle.mockReturnValue(true); await f.hooks.get("agent_settled")({}, f.ctx);
		}
		if (kind === "cancelled") f.shutdown();
		else await vi.advanceTimersByTimeAsync(5_000);
	} finally { vi.useRealTimers(); }
	branch.push({ type: "custom_message", id: "late-list", customType: "scheduled-task", details: { includeAll: true, tasks: [{ id: "owned", name: "goals-copy-only", action: "prompt", scope: "session", sessionFile: f.ctx.sessionManager.getSessionFile() }] } });
	writeFileSync(f.ctx.sessionManager.getSessionFile(), "late persistence");
	await delay(20);
	expect(f.messages.map(message => message.message.content)).toEqual(kind === "missing" ? [] : ["/schedules all"]);
	if (kind !== "cancelled") expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("removal unconfirmed"), "warning");
});

it.each(["missing", "empty"])("clear resets a %s plan without a model call", async kind => {
	const f = fixture(); await f.draft(); const before = f.messages.length;
	if (kind === "missing") rmSync(f.path); else writeFileSync(f.path, "");
	await f.command("clear");
	expect(f.entries.at(-1).data).toEqual({ mode: "chat" });
	expect(f.messages).toHaveLength(before);
});

it("discusses plan changes only during planning", async () => {
	const f = fixture(); await f.command("discuss"); expect(f.messages).toHaveLength(0);
	await f.draft(); const sent = f.messages.length;
	f.ctx.ui.select.mockResolvedValueOnce("discuss — Discuss changes to the plan"); await f.command("");
	expect(f.messages).toHaveLength(sent);
	expect(readFileSync(f.path, "utf8")).toBe(f.plan);
	expect(f.entries.at(-1).data.mode).toBe("planning");
	await f.command("ready"); const before = f.messages.length;
	await f.command("discuss"); expect(f.messages).toHaveLength(before);
});

it("automatically proposes a changed settled draft once and preserves Discuss", async () => {
	const f = fixture(); await f.draft();
	f.ctx.ui.select.mockResolvedValueOnce("Discuss");
	await f.hooks.get("agent_settled")({}, f.ctx);
	expect(f.messages.some(m => m.message.customType === "goal-plan-proposal" && m.message.content === f.plan)).toBe(true);
	expect(f.entries.at(-1).data.mode).toBe("planning");
	const calls = f.ctx.ui.select.mock.calls.length;
	await f.hooks.get("agent_settled")({}, f.ctx);
	expect(f.ctx.ui.select).toHaveBeenCalledTimes(calls);
	writeFileSync(f.path, f.plan.replace("first output", "revised output"));
	f.ctx.ui.select.mockResolvedValueOnce("Ready");
	await f.hooks.get("agent_settled")({}, f.ctx);
	expect(f.entries.at(-1).data.mode).toBe("supervising");
});

it("does not propose an empty draft or a delegated worker's plan", async () => {
	const f = fixture(); await f.command("new");
	await f.hooks.get("agent_settled")({}, f.ctx);
	expect(f.ctx.ui.select).not.toHaveBeenCalled();
	const child = fixture(true); await child.hooks.get("agent_settled")({}, child.ctx);
	expect(child.ctx.ui.select).not.toHaveBeenCalled();
});

it("keeps Ready in the same chat, sends saved notices and never installs a context hook", async () => {
	const f = fixture(); await f.draft(); await f.command("review");
	expect(f.entries.at(-1).data.mode).toBe("supervising");
	expect(f.messages.at(-1).options).toEqual({ deliverAs: "followUp" });
	expect(f.messages.at(-1).savedPrompt).toBe(true);
	expect(f.messages.at(-1).message.content).toContain("goals-worker");
	expect(f.hooks.has("context")).toBe(false);
	const event = { systemPrompt: "original system" };
	expect(f.hooks.get("before_agent_start")(event, f.ctx).systemPrompt).toContain("original system");
	f.hooks.get("session_compact")();
	expect(f.hooks.get("before_agent_start")(event, f.ctx).message.content).toContain("Current goal mode: supervising");
	f.shutdown();
});

it("rejects a plan changed while the human was reviewing it", async () => {
	const f = fixture(); await f.draft();
	f.ctx.ui.select.mockImplementation(async () => { writeFileSync(f.path, "- [ ] goal: substituted\n"); return "Ready"; });
	await f.command("review"); expect(f.entries.at(-1).data.mode).toBe("planning");
});

it("reloads a paused plan without launching, and retains the public worker session handle", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.launch({ id: "child-1", sessionFile: "/tmp/child.jsonl" });
	await f.command("stop");
	expect(f.messages.at(-1).message.content).toContain("Remote stop is NOT yet confirmed");
	f.hooks.get("session_start")({}, f.ctx);
	expect(f.hooks.get("tool_call")({ toolName: "OpenGoalWorker" }).block).toBe(true);
	await f.command("resume");
	expect(f.messages.at(-1).message.content).toContain("/tmp/child.jsonl");
	await f.command("exit"); expect(f.entries.at(-1).data.mode).toBe("chat");
	expect(readFileSync(f.path, "utf8")).toContain("first output");
});

it.each(["FIRST OUTPUT", "renamed output", "duplicate", "historical"])("completion uses exact current subjects (%s)", async (subject) => {
	const f = fixture(); await f.draft(); await f.command("ready");
	const evidence = join(f.ctx.cwd, "verification.txt"); writeFileSync(evidence, "PASS");
	const suffix = subject === "duplicate" ? "- [ ] goal: first output\n" : "";
	const history = "## Log\n- [ ] goal: first output\n";
	writeFileSync(f.path, "- [ ] goal: first output\n  - [ ] unrelated task\n" + suffix + history);
	const before = readFileSync(f.path, "utf8");
	const params = { goal: subject === "duplicate" || subject === "historical" ? "first output" : subject, evidence: [evidence], observation: "Read actual output" };
	const first = await f.tools.get("CompleteGoal").execute("c", params, undefined, undefined, f.ctx);
	if (first.content[0].text.includes("Final review queued")) {
		f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
		await f.tools.get("CompleteGoal").execute("c", params, undefined, undefined, f.ctx);
	}
	const after = readFileSync(f.path, "utf8");
	if (subject === "renamed output" || subject === "duplicate") expect(after).toBe(before);
	else { expect(after).toContain("- [✓] goal: first output"); expect(after.split("## Log")[1]).toContain("\n- [ ] goal: first output\n"); expect(after).toContain("- [ ] unrelated task"); }
});

it("rejects an existing zero-byte evidence file", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	const evidence = join(f.ctx.cwd, "empty.log"); writeFileSync(evidence, "");
	const before = readFileSync(f.path, "utf8");
	const result = await f.tools.get("CompleteGoal").execute("c", { goal: "first output", evidence: [evidence], observation: "claim" }, undefined, undefined, f.ctx);
	expect(result.content[0].text).toContain("Empty evidence"); expect(readFileSync(f.path, "utf8")).toBe(before);
});

it("requires actual nonempty evidence, distinguishes manual ticks, and retains reviewed markers through Clear/reattach", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	const complete = (goal: string, evidence: string[], signal?: AbortSignal) => f.tools.get("CompleteGoal").execute("t", { goal, evidence, observation: "Inspected exact saved bytes" }, signal, undefined, f.ctx);
	expect((await complete("first output", ["missing.log"])).content[0].text).toContain("Evidence unavailable");
	mkdirSync(join(f.ctx.cwd, "evidence")); writeFileSync(join(f.ctx.cwd, "evidence/pass.log"), "actual fixture bytes\n");
	expect((await complete("first output", ["evidence/pass.log"], AbortSignal.abort())).content[0].text).toContain("Cancelled");
	await complete("first output", ["evidence/pass.log"]);
	await f.command("clear");
	f.ctx.ui.select.mockResolvedValueOnce("Previous supervisor confirmed stopped"); await f.command(`attach ${f.path}`); await f.command("ready");
	writeFileSync(f.path, readFileSync(f.path, "utf8").replace("[ ] goal: second", "[x] goal: second"));
	f.hooks.get("session_start")({}, f.ctx);
	expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("goals", "👀 1/2 goals");
	expect(f.ctx.ui.setWidget.mock.lastCall?.[1]).toContain("✓ G1: first output");
	expect(f.ctx.ui.setWidget.mock.lastCall?.[1]).toContain("x G2: second output");
	f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	for (let i = 0; i < 9; i++) f.hooks.get("turn_end")({}, f.ctx);
	const reminder = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message.content;
	expect(reminder).toContain("[x] goal: second output");
	expect(reminder).not.toContain("first output");
	writeFileSync(f.path, readFileSync(f.path, "utf8").replace("[✓] goal: first", "[ ] goal: first"));
	f.hooks.get("agent_end")({ messages: [] }, f.ctx);
	expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("goals", "👀 0/2 goals");
	writeFileSync(f.path, readFileSync(f.path, "utf8").replace("[ ] goal: first", "[x] goal: first"));
	f.hooks.get("agent_end")({ messages: [] }, f.ctx);
	expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("goals", "👀 0/2 goals");
	f.shutdown();
});

it("reviews a plan replaced atomically with a current-file notice, and ignores writes that keep the same content", async () => {
	const f = fixture(); await f.draft();
	const plan = `# Context title

A short introduction for ordinary reminders.

## User-visible result
A visible artifact.

## User voice
- > "The full requirement must survive resync."

## Goals
- [ ] goal: produce the artifact
  - tasks:
    - [ ] run the detailed check

## Log
old progress`;
	writeFileSync(f.path, plan); await f.command("ready");
	const revised = plan.replace("A visible artifact.", "A revised visible artifact.");
	await f.atomicWrite(revised);
	await waitFor(() => f.changed() === 1);
	const review = f.messages.find((m) => m.message.content.includes("Plan changed"))?.message.content;
	expect(review).toContain("inspect current requirements");
	expect(review).toContain(f.path);
	expect(review).not.toContain("The full requirement must survive resync.");
	expect(review).not.toContain("run the detailed check");
	f.hooks.get("message_end")({ message: { role: "user", content: review } });
	await f.atomicWrite(revised.replace("A revised", "A second revised"));
	await waitFor(() => f.changed() === 2);
	// Rewriting identical bytes must not retrigger the review event hook.
	const same = revised.replace("A revised", "A second revised");
	writeFileSync(f.path, same); await delay(300);
	expect(f.changed()).toBe(2);
	f.shutdown();
});

it("delivers changed plans while coalescing only its own pending notice", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.ctx.hasPendingMessages.mockReturnValue(true); // An unrelated queued prompt must not suppress the notice.
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: first burst edit\n## Log"));
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: second burst edit\n## Log"));
	await waitFor(() => f.changed() === 1);
	f.hooks.get("message_end")({ message: { role: "user", content: "unrelated input" } });
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: later queued edit\n## Log"));
	await delay(200);
	expect(f.changed()).toBe(1);
	f.hooks.get("message_end")({ message: { role: "user", content: f.messages.at(-1).message.content } });
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: after same-run delivery\n## Log"));
	await waitFor(() => f.changed() === 2);
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message.content).toContain("after same-run delivery");
	f.hooks.get("message_end")({ message: { role: "user", content: f.messages.at(-1).message.content } });
	await f.atomicWrite(f.plan.replaceAll("[ ] goal:", "[-] goal:"));
	await waitFor(() => f.changed() === 3); // Cancelling the last goals must still notify an ongoing run.
	f.shutdown();
});

it("stops plan watching on shutdown and re-arms it on reload without duplicating events", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.shutdown();
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: ignored while shut down\n## Log"));
	await delay(150);
	expect(f.changed()).toBe(0);
	f.hooks.get("session_start")({}, f.ctx);
	await f.atomicWrite(f.plan.replace("## Log", "- discriminator: seen after reload\n## Log"));
	await waitFor(() => f.changed() === 1);
	expect(f.changed()).toBe(1);
	f.shutdown();
});

it("does not retrigger a review for its own CompleteGoal plan write", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	mkdirSync(join(f.ctx.cwd, "evidence")); writeFileSync(join(f.ctx.cwd, "evidence/pass.log"), "bytes\n");
	await f.tools.get("CompleteGoal").execute("t", { goal: "first output", evidence: ["evidence/pass.log"], observation: "inspected" }, undefined, undefined, f.ctx);
	await delay(200);
	expect(f.changed()).toBe(0);
	f.shutdown();
});

it("gives pause scheduler guidance but clears on exit without a model prompt", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.command("stop");
	const stop = f.messages.at(-1).message.content;
	expect(stop).toContain('goals-copy-only"');
	expect(stop).toContain("Do not add, enable or recreate any job");
	expect(stop).not.toContain("interval '1h'");
	expect(stop).toContain("Remote stop is NOT yet confirmed");
	const task = { id: "owned", name: "goals-copy-only", action: "prompt", scope: "session", sessionFile: f.ctx.sessionManager.getSessionFile(), disabledAt: "2026-09-14T01:00:00Z" };
	f.hooks.get("tool_result")({ toolName: "manage_scheduled_task", input: { action: "disable" }, details: { task } }, f.ctx);
	f.shutdown(); f.hooks.get("session_start")({}, f.ctx);
	await f.command("resume");
	expect(f.messages.at(-1).message.content).toContain(task.disabledAt);
	expect(f.messages.at(-1).message.content).toContain("Leave later human edits unchanged");
	expect(f.hooks.get("tool_call")({ toolName: "schedule_task", input: { name: task.name, action: "prompt", type: "interval", scope: "session", prompt: "custom\n  indentation" } }, f.ctx).block).toBe(true);
	f.ctx.sessionManager.getBranch().push({ type: "message", message: { role: "toolResult", toolName: "schedule_task", details: { task } } });
	expect(f.hooks.get("tool_call")({ toolName: "manage_scheduled_task", input: { action: "update", id: "own", prompt: "custom\n  indentation" } }, f.ctx).block).toBe(true);
	const before = f.messages.length;
	await f.command("exit");
	expect(f.messages).toHaveLength(before);
	expect(f.entries.at(-1).data).toEqual({ mode: "chat" });
});

it("requires a full-plan review turn before recording the final goal", async () => {
	const f = fixture(); await f.draft();
	const plan = `# Final review fixture
- [ ] goal: first output
  - discriminator: first output has exact saved bytes
- [ ] goal: second output
  - discriminator: second output has exact saved bytes

## Log
- worker evidence: keep this history in the final review`;
	writeFileSync(f.path, plan); await f.command("ready");
	f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	mkdirSync(join(f.ctx.cwd, "evidence")); writeFileSync(join(f.ctx.cwd, "evidence/pass.log"), "bytes\n");
	const complete = (goal: string) => f.tools.get("CompleteGoal").execute("t", { goal, evidence: ["evidence/pass.log"], observation: "inspected" }, undefined, undefined, f.ctx);
	await complete("first output");
	const queued = await complete("second output");
	expect(queued.content[0].text).toContain("Final review queued");
	expect(readFileSync(f.path, "utf8")).toContain("- [ ] goal: second output");
	const direct = f.messages.at(-1);
	expect(direct.savedPrompt).toBe(true);
	expect(direct.message.content).toContain("Read the complete file at");
	expect(direct.message.content).not.toContain("worker evidence: keep this history");
	// A queued follow-up may be consumed without another before_agent_start.
	f.hooks.get("message_end")({ message: { role: "user", content: direct.message.content } });
	expect(readFileSync(f.path, "utf8")).toContain("second output has exact saved bytes");
	f.hooks.get("turn_end")({}, f.ctx); // Evidence-reading tool round must not invalidate this review.
	const finalText = (await complete("second output")).content[0].text;
	expect(finalText).toContain("All non-cancelled goals are reviewed.");
	expect(finalText).toContain('name "goals-copy-only"');
	expect(finalText).toContain("Never use cleanup or change foreign tasks");
	for (let i = 0; i < 10; i++) f.hooks.get("turn_end")({}, f.ctx);
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message).toBeUndefined();
	f.shutdown();
});

it("recovers a queued final review and invalidates it when the plan changes", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	const complete = (goal: string) => f.tools.get("CompleteGoal").execute("t", { goal, evidence: ["proof.log"], observation: "inspected" }, undefined, undefined, f.ctx);
	await complete("first output");
	await complete("second output");
	const oldPrompt = f.messages.at(-1).message.content;
	f.hooks.get("session_start")({}, f.ctx);
	const recovered = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message;
	expect(recovered).toMatchObject({ customType: "pi-goals-final-review" });
	expect(recovered.content).toContain("- [ ] goal: second output");
	writeFileSync(f.path, readFileSync(f.path, "utf8").replace("## Log", "  - discriminator: changed exact bytes\n## Log"));
	const invalidated = await complete("second output");
	expect(invalidated.content[0].text).toContain("plan changed since the final review");
	const changed = await complete("second output");
	expect(changed.content[0].text).toContain("Final review queued");
	expect(readFileSync(f.path, "utf8")).toContain("- [ ] goal: second output");
	expect(f.messages.at(-1).message.content).toContain("second output");
	f.hooks.get("message_end")({ message: { role: "user", content: oldPrompt } });
	expect((await complete("second output")).content[0].text).toContain("Final review queued");
	f.shutdown();
});

it("restores the active plan above Log after session restore", async () => {
	const f = fixture(); await f.draft();
	const plan = `${f.plan.replace("## Log", "## User voice\n- > \"Keep the user voice after restore.\"\n## Log")}old progress`;
	writeFileSync(f.path, plan); await f.command("ready");
	f.hooks.get("session_start")({}, f.ctx);
	const restored = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(restored.message.content).toContain("Keep the user voice after restore.");
	expect(restored.message.content).not.toContain("old progress");
});

it("restores the active plan above Log after compaction without reinstalling or overriding scheduler jobs", async () => {
	const f = fixture(); await f.draft();
	const plan = `${f.plan.replace("## Log", "## User voice\n- > \"Keep this exact requirement.\"\n  - task detail\n## Log")}old progress`;
	writeFileSync(f.path, plan); await f.command("ready");
	f.hooks.get("session_compact")();
	const result = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(result.systemPrompt).not.toContain("add one session-bound");
	expect(result.message.content).toContain("Keep this exact requirement.");
	expect(result.message.content).toContain("task detail");
	expect(result.message.content).not.toContain("old progress");
	expect(result.message.content).toContain(f.path);
});

it("recovers from an unreadable plan after compaction instead of restarting work", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	rmSync(f.path);
	f.hooks.get("session_compact")();
	const result = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(result.systemPrompt).toContain("ENOENT");
	expect(result.systemPrompt).toContain("do not restart completed work");
	writeFileSync(f.path, f.plan);
	const restored = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message.content;
	expect(restored).toContain("- [ ] goal: first output");
	expect(restored).toContain(f.path);
	f.shutdown();
});

it("requires confirmed worker stop before solo takeover and never lets two writers run together", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.launch({ id: "child-1", sessionFile: "/tmp/child.jsonl" });
	f.ctx.ui.select.mockResolvedValueOnce("Cancel");
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("supervising"); // cancelled
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped");
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("solo");
	expect(f.hooks.get("tool_call")({ toolName: "subagent" }).block).toBe(true);
	expect(f.hooks.get("tool_call")({ toolName: "OpenGoalWorker" }).block).toBe(true);
	expect(f.hooks.get("tool_call")({ toolName: "read" })).toBeUndefined();
	mkdirSync(join(f.ctx.cwd, "evidence")); writeFileSync(join(f.ctx.cwd, "evidence/pass.log"), "bytes\n");
	const text = (await f.tools.get("CompleteGoal").execute("t", { goal: "first output", evidence: ["evidence/pass.log"], observation: "inspected" }, undefined, undefined, f.ctx)).content[0].text;
	expect(text).toContain("self-verification");
});

it("attaches an existing plan without restarting completed work, and restores its noted worker session", async () => {
	const f = fixture();
	const existing = join(f.ctx.cwd, "existing.md");
	writeFileSync(existing, "# Plan\n- preferred worker model: deepseek flash\n- worker session: /tmp/attach-child.jsonl\n- [ ] goal: attached goal\n\n## Log\n- previous progress kept\n");
	f.ctx.ui.select.mockResolvedValueOnce("Previous supervisor confirmed stopped");
	await f.command(`attach ${existing}`);
	expect(f.entries.at(-1).data.mode).toBe("planning");
	expect(f.entries.at(-1).data.plan).toBe(existing);
	expect(f.messages.at(-1).message.content).toContain("without restarting completed work");
	expect(f.messages.at(-1).message.content).toContain("/tmp/attach-child.jsonl");
});

it("attaches directly into solo mode and reports the recorded session in status", async () => {
	const f = fixture();
	const existing = join(f.ctx.cwd, "existing.md");
	writeFileSync(existing, "# Plan\n- worker session: /tmp/attach-child.jsonl\n- [ ] goal: attached goal\n\n## Log\n");
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped");
	await f.command(`attach ${existing} solo`);
	expect(f.entries.at(-1).data.mode).toBe("solo");
	expect(f.entries.at(-1).data.worker?.sessionFile).toBe("/tmp/attach-child.jsonl");
	await f.command("status");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("/tmp/attach-child.jsonl"), "info");
});

it("rejects attaching a missing or goal-less file", async () => {
	const f = fixture();
	await f.command("attach /no/such/plan.md");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Cannot read plan"), "error");
	const goalLess = join(f.ctx.cwd, "notes.md");
	writeFileSync(goalLess, "# notes\n");
	await f.command(`attach ${goalLess}`);
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("has no '- [ ] goal:' lines"), "warning");
	expect(f.entries).toEqual([]); // nothing saved: the session was not attached
});

it.each(["exit", "quit", "clear", "menu"])("%s exits planning with the draft preserved and nothing implemented", async command => {
	const f = fixture(); await f.draft();
	await f.command("stop");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("A draft cannot pause"), "warning");
	const before = f.messages.length;
	if (command === "menu") f.ctx.ui.select.mockResolvedValueOnce("quit — Exit and clear goals");
	await f.command(command === "menu" ? "" : command);
	expect(f.entries.at(-1).data.mode).toBe("chat");
	expect(f.ctx.ui.setWidget).toHaveBeenLastCalledWith("goals", undefined);
	expect(readFileSync(f.path, "utf8")).toContain("first output");
	expect(f.messages.length).toBe(before); // notify only, no model turn started
	f.ctx.ui.select.mockResolvedValueOnce("Previous supervisor confirmed stopped");
	await f.command(`attach ${f.path}`);
	expect(f.entries.at(-1).data.mode).toBe("planning");
});

it("records the preferred worker model as a visible plan preference", async () => {
	const f = fixture(); await f.draft();
	await f.command("model deepseek flash");
	expect(readFileSync(f.path, "utf8")).toContain("- preferred worker model: deepseek flash");
	await f.command("status");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("deepseek flash"), "info");
});

it.each(["solo", "attach"])("%s takeover cannot bypass confirmation or survive a lifecycle change during the menu", async kind => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.launch({ id: "child", sessionFile: "/tmp/prior.jsonl" });
	let answer!: (choice: string) => void;
	f.ctx.ui.select.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
	const takeover = f.command(kind === "solo" ? "solo" : `attach ${f.path} solo`);
	expect(f.entries.at(-1).data.mode).toBe("supervising");
	await f.command("stop");
	answer("Worker confirmed stopped"); await takeover;
	expect(f.entries.at(-1).data.mode).toBe("paused");
	expect(f.entries.at(-1).data.workerStopped).not.toBe(true);
});

it("attach solo requires stop confirmation for a noted worker even in a fresh session", async () => {
	const f = fixture(); const path = join(f.ctx.cwd, "saved.md");
	writeFileSync(path, `# Plan\n- worker session: /tmp/known.jsonl\n${f.plan}`);
	f.ctx.ui.select.mockResolvedValueOnce("Cancel");
	await f.command(`attach ${path} solo`);
	expect(f.entries).toHaveLength(0);
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped");
	await f.command(`attach ${path} solo`);
	expect(f.entries.at(-1).data).toMatchObject({ mode: "solo", workerStopped: true, worker: { sessionFile: "/tmp/known.jsonl" } });
	expect(readFileSync(path, "utf8")).toContain("worker session: /tmp/known.jsonl");
});

it("retains the stopped session reference across plan changes", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.launch({ id: "child", sessionFile: "/tmp/prior.jsonl" });
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	const other = join(f.ctx.cwd, "another.md"); writeFileSync(other, "- [ ] goal: next\n## Log\n");
	f.ctx.ui.select.mockResolvedValueOnce("Previous supervisor confirmed stopped");
	await f.command(`attach ${other}`);
	expect(f.entries.at(-1).data).toMatchObject({ mode: "planning", plan: other, workerStopped: true, worker: { sessionFile: "/tmp/prior.jsonl" } });
	await f.command("ready");
	const response = await f.tools.get("OpenGoalWorker").execute("open", { task: "next task" }, undefined, undefined, f.ctx);
	expect(response.content[0].text).toContain("already recorded");
	expect(f.entries.at(-1).data.workerStopped).toBe(true);
});

it("solo closes a pending plan watcher and sends removal-only scheduler guidance", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	await f.atomicWrite(f.plan.replace("first output", "changed output"));
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	expect(f.messages.at(-1).message.content).toContain('name "goals-copy-only", action prompt, scope session');
	expect(f.messages.at(-1).message.content).toContain("sessionFile exactly your current saved session");
	expect(f.messages.at(-1).message.content).toContain("Do not add, enable or recreate any job");
	await delay(250);
	await f.atomicWrite(f.plan.replace("first output", "solo output"));
	await delay(250);
	expect(f.changed()).toBe(0);
});

it.each(["missing", "empty", "directory"])("%s plan snapshots remain unavailable and resync retries after repair", async failure => {
	const f = fixture(); await f.draft(); await f.command("ready");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	await f.tools.get("CompleteGoal").execute("c", { goal: "first output", evidence: ["proof.log"], observation: "Observed PASS" }, undefined, undefined, f.ctx);
	const signed = readFileSync(f.path, "utf8");
	if (failure === "empty") writeFileSync(f.path, "");
	else { rmSync(f.path); if (failure === "directory") mkdirSync(f.path); }
	await delay(250); // also exercise unavailable read after debounce has expired
	f.hooks.get("agent_end")({ messages: [] }, f.ctx);
	expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("goals", expect.stringContaining("unavailable"));
	f.hooks.get("session_compact")();
	const unavailable = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(unavailable.systemPrompt).toContain("unavailable");
	expect(unavailable.message).toBeUndefined();
	if (failure === "directory") rmSync(f.path, { recursive: true });
	writeFileSync(f.path, signed);
	const resync = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(resync.message.content).toContain("- [✓] goal: first output");
	expect(readFileSync(f.path, "utf8")).toContain("Observed PASS");
	await delay(250);
	expect(f.changed()).toBe(0);
});

it("ignores post-completion maintenance but reviews evidence, requirement or manual reopening changes", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	for (const goal of ["first output", "second output"]) await f.tools.get("CompleteGoal").execute("c", { goal, evidence: ["proof.log"], observation: "PASS" }, undefined, undefined, f.ctx);
	const signed = readFileSync(f.path, "utf8");
	await f.atomicWrite(signed.replace("## Log", "## Log\n- recap: finished"));
	await delay(250);
	expect(f.changed()).toBe(0); // Log-only edits are history, not requirements
	// Worker-authored evidence above the Log must surface: a supervisor caught a worker's
	// contradictory evidence block through exactly this event (LUCID3, 2026-09-10).
	await f.atomicWrite(signed.replace("## Log", "  - evidence: proof.log\n## Log\n- recap: finished"));
	await waitFor(() => f.changed() === 1);
	f.hooks.get("message_end")({ message: { role: "user", content: f.messages.at(-1).message.content } });
	await f.atomicWrite(signed.replace("## Log", "- discriminator: exact bytes and trailing newline\n## Log"));
	await waitFor(() => f.changed() === 2);
	expect(readFileSync(f.path, "utf8")).toContain("[✓] goal: first output"); // Supervisor decides whether changed requirements require reopening.
	f.hooks.get("message_end")({ message: { role: "user", content: f.messages.at(-1).message.content } });
	await f.atomicWrite(signed.replace("[✓] goal: first", "[ ] goal: first"));
	await waitFor(() => f.changed() === 3);
	expect(readFileSync(f.path, "utf8")).toContain("[ ] goal: first output");
});

it("cancelled goals do not prevent final cleanup, and solo writes self-verification in Log", async () => {
	const f = fixture(); await f.draft();
	writeFileSync(f.path, f.plan.replace("[ ] goal: second", "[-] goal: second") + "\n## Appendix\nPreserved context\n");
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	const params = { goal: "first output", evidence: ["proof.log"], observation: "Exact bytes observed" };
	const queued = await f.tools.get("CompleteGoal").execute("c", params, undefined, undefined, f.ctx);
	expect(queued.content[0].text).toContain("Final review queued");
	f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	const done = await f.tools.get("CompleteGoal").execute("c", params, undefined, undefined, f.ctx);
	expect(done.content[0].text).toContain("All non-cancelled goals are reviewed");
	const text = readFileSync(f.path, "utf8");
	expect(text).toContain("Solo self-verification:");
	expect(text).not.toContain("Parent review:");
	expect(text.indexOf("Solo self-verification:")).toBeLessThan(text.indexOf("## Appendix"));
	expect(text).toContain("Preserved context");
});

it("persisted child attaches its plan without a widget, retains task context, and cannot complete", async () => {
	const f = fixture(true);
	const supplied = join(f.ctx.cwd, "supplied.md");
	const text = "- [/] goal: exact file\n  - [ ] verify bytes\n## Log\n  - [ ] archived task\n";
	writeFileSync(supplied, text);
	const before = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(before.systemPrompt).toContain("AttachGoalPlan");
	const attach = f.tools.get("AttachGoalPlan");
	await attach.execute("a", { path: "supplied.md" }, undefined, undefined, f.ctx);
	expect(f.entries.at(-1).data.plan).toBeUndefined(); // no cwd heuristics
	await attach.execute("a", { path: supplied }, undefined, undefined, f.ctx);
	expect(f.ctx.ui.setWidget).toHaveBeenLastCalledWith("goals", undefined);
	expect(readFileSync(supplied, "utf8")).toBe(text);
	f.hooks.get("session_start")({}, f.ctx);
	expect(f.ctx.ui.setWidget).toHaveBeenLastCalledWith("goals", undefined);
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message.content).toContain("exact file");
	const completion = await f.tools.get("CompleteGoal").execute("c", { goal: "exact file", evidence: [], observation: "claim" }, undefined, undefined, f.ctx);
	expect(completion.content[0].text).toContain("only to the active parent");
});

it("prioritizes unfinished goals and says when the widget list is truncated", async () => {
	const f = fixture(); await f.draft();
	writeFileSync(f.path, "- [✓] goal: completed one\n- [✓] goal: completed two\n- [/] goal: active work\n- [ ] goal: open one\n- [ ] goal: open two\n");
	await f.command("ready");
	expect(f.ctx.ui.setWidget.mock.lastCall?.[1]).toEqual(["◼ G3: active work", "◻ G4: open one", "◻ G5: open two", `… 2 ✓; ${relative(f.ctx.cwd, f.path)}`]);
	f.shutdown();
});

it.each([
	["[✓]", "[ ]", "[ ]", "… 1 ✓, 2 ◻"],
	["[/]", "[✓]", "[-]", "… 1 ✓, 1 ◼, 1 ✗"],
	["[ ]", "[ ]", "[ ]", "… 3 ◻"],
])("summarizes only hidden goal statuses: %s %s %s", async (first, second, third, summary) => {
	const f = fixture(); await f.draft();
	const marks = ["[/]", "[/]", "[/]", first, second, third];
	writeFileSync(f.path, marks.map((mark, index) => `- ${mark} goal: output ${index + 1}`).join("\n"));
	await f.command("ready");
	expect(f.ctx.ui.setWidget.mock.lastCall?.[1]).toEqual([
		"◼ G1: output 1", "◼ G2: output 2", "◼ G3: output 3", `${summary}; ${relative(f.ctx.cwd, f.path)}`,
	]);
	f.shutdown();
});

it.each(["solo", "supervising"])("%s widget omits long tasks without altering the plan", async mode => {
	const f = fixture(); await f.draft();
	const text = "- [/] goal: first output\n  - [ ] a long task that should never take widget space\n- [ ] goal: second output\n## Log\n";
	writeFileSync(f.path, text);
	if (mode === "solo") { f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo"); }
	else await f.command("ready");
	expect(f.ctx.ui.setWidget.mock.lastCall?.[1]).toEqual(["◼ G1: first output", "◻ G2: second output", relative(f.ctx.cwd, f.path)]);
	f.ctx.cwd = join(f.ctx.cwd, "another-project", "nested");
	await f.command("status");
	expect(f.ctx.ui.setWidget.mock.lastCall?.[1]).toEqual(["◼ G1: first output", "◻ G2: second output", `${basename(f.path)} (external)`]);
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`Plan: ${f.path}`), "info");
	f.ctx.mode = "tui";
	await f.command("status");
	const widget = f.ctx.ui.setWidget.mock.lastCall?.[1]();
	expect(widget.render(100)).toEqual([" ◼ G1: first output", " ◻ G2: second output", ` ${basename(f.path)} (external)`]);
	expect(widget.render(24)).toHaveLength(3);
	expect(widget.render(24).every((line: string) => visibleWidth(line) <= 24)).toBe(true);
	expect(readFileSync(f.path, "utf8")).toBe(text);
});

it.each(["solo", "supervising"])("%s upkeep is turn-driven, folds Log, and joins the next ordinary prompt once", async mode => {
	const f = fixture(); await f.draft();
	if (mode === "solo") { f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo"); }
	else await f.command("ready");
	f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	const reminders = () => f.messages.filter(m => m.message.customType === "pi-goals-upkeep");
	f.hooks.get("turn_end")({}, f.ctx); // observe initial working set
	for (let i = 0; i < 7; i++) {
		writeFileSync(f.path, f.plan + `- historical recap ${i}\n`);
		f.hooks.get("turn_end")({}, f.ctx);
	}
	expect(reminders()).toHaveLength(0);
	f.hooks.get("turn_end")({}, f.ctx);
	for (let i = 0; i < 16; i++) f.hooks.get("turn_end")({}, f.ctx);
	expect(reminders()).toHaveLength(0); // No direct send, even after the run would finish.
	const reminder = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message;
	expect(reminder.customType).toBe("pi-goals-upkeep");
	expect(reminder.content).toContain(f.path);
	expect(reminder.content).toContain("first output");
	expect(reminder.content).not.toContain("historical recap");
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message).toBeUndefined();
	writeFileSync(f.path, f.plan.replace("first output", "refined output"));
	f.hooks.get("turn_end")({}, f.ctx);
	for (let i = 0; i < 7; i++) f.hooks.get("turn_end")({}, f.ctx);
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message.content).toContain("refined output");
	await f.command("stop");
	for (let i = 0; i < 10; i++) f.hooks.get("turn_end")({}, f.ctx);
	expect(reminders()).toHaveLength(0);
});

it("injects only unfinished goal lines after the bounded unchanged-turn reminder", async () => {
	const f = fixture(); await f.draft();
	const plan = `# Context title

A short introduction.

## User-visible result
A visible artifact.

## User voice
- > "Keep this exact user requirement."

## Goals
- [/] goal: produce the artifact
  - tasks:
    - [ ] run the detailed check
  - evidence: proof.log

## Log
old progress`;
	writeFileSync(f.path, plan); await f.command("ready");
	// Consume active context before observing the routine reminder.
	f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	for (let i = 0; i < 9; i++) f.hooks.get("turn_end")({}, f.ctx);
	const reminder = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message;
	expect(reminder.customType).toBe("pi-goals-upkeep");
	expect(reminder.content).not.toContain("Keep this exact user requirement.");
	expect(reminder.content).toContain("goal: produce the artifact");
	expect(reminder.content).not.toContain("run the detailed check");
	expect(reminder.content).not.toContain("proof.log");
	expect(reminder.content).not.toContain("old progress");
});

it.each(["supervising", "solo"])("%s repeats concise upkeep every eight unchanged turns", async mode => {
	const f = fixture(); await f.draft();
	if (mode === "solo") { f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo"); }
	else await f.command("ready");
	const prepare = () => f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	prepare();
	for (let i = 0; i < 9; i++) f.hooks.get("turn_end")({}, f.ctx);
	f.hooks.get("session_compact")();
	expect(prepare().message.customType).toBe("pi-goals-plan");
	const sent = f.messages.length;
	for (let round = 0; round < 2; round++) {
		for (let turn = 0; turn < 7; turn++) f.hooks.get("turn_end")({}, f.ctx);
		expect(prepare().message).toBeUndefined();
		f.hooks.get("turn_end")({}, f.ctx);
		expect(f.messages).toHaveLength(sent);
		expect(prepare().message).toMatchObject({
			customType: "pi-goals-upkeep",
			content: upkeep(f.path, f.plan.split("\n").filter(line => line.includes("goal:")).join("\n")),
		});
		expect(prepare().message).toBeUndefined();
	}
});

it("a launch started during takeover invalidates the menu without disabling plan watching", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	let answer!: (choice: string) => void;
	f.ctx.ui.select.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
	const solo = f.command("solo");
	await f.launch({ id: "late-child", sessionFile: "/tmp/late.jsonl" });
	answer("Worker confirmed stopped"); await solo;
	expect(f.entries.at(-1).data.mode).toBe("supervising");
	expect(f.entries.at(-1).data.workerStopped).toBe(false);
	await f.atomicWrite(f.plan.replace("first output", "new requirement"));
	await waitFor(() => f.changed() === 1);
});

it("changed plan or shutdown during takeover never grants solo permission", async () => {
	const f = fixture(); await f.draft();
	f.ctx.ui.select.mockImplementationOnce(async () => { writeFileSync(f.path, f.plan.replace("first", "changed")); return "Worker confirmed stopped"; });
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("planning");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Plan changed during takeover"), "warning");
	f.ctx.ui.select.mockImplementationOnce(async () => { f.shutdown(); return "Worker confirmed stopped"; });
	await f.command("solo");
	expect(f.entries.at(-1).data.mode).toBe("planning");
});

it("requires explicit supervisor ownership confirmation when attaching an existing plan", async () => {
	const f = fixture(); const path = join(f.ctx.cwd, "shared.md");
	writeFileSync(path, f.plan);
	f.ctx.ui.select.mockResolvedValueOnce("Cancel");
	await f.command(`attach ${path}`);
	expect(f.entries).toHaveLength(0);
	f.ctx.ui.select.mockResolvedValueOnce("Previous supervisor confirmed stopped");
	await f.command(`attach ${path}`);
	expect(f.entries.at(-1).data).toMatchObject({ mode: "planning", plan: path });
});

it("does not approve cancelled goals or display current completion for an unavailable plan", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	writeFileSync(f.path, "- [-] goal: cancelled output\n## Log\n");
	writeFileSync(join(f.ctx.cwd, "evidence.log"), "verified\n");
	const reply = await f.tools.get("CompleteGoal").execute("t", { goal: "cancelled output", evidence: ["evidence.log"], observation: "read" }, undefined, undefined, f.ctx);
	expect(reply.content[0].text).toContain("no sign-off recorded");
	expect(readFileSync(f.path, "utf8")).toContain("[-]");
	rmSync(f.path);
	f.hooks.get("agent_end")({ messages: [] }, f.ctx);
	expect(f.ctx.ui.setWidget).toHaveBeenLastCalledWith("goals", [expect.stringContaining("unavailable")]);
});

it("keeps interactive workers open", () => {
	const task = workerAssignment("/plan.md", "parent", "request", "bounded task");
	expect(task).toContain("do not exit, reset, switch session or close the pane");
});

it.each(["stop", "exit", "edit", "session_tree"])("discards pending upkeep after %s instead of reviving stale work", async change => {
	const f = fixture(); await f.draft();
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	for (let i = 0; i < 9; i++) f.hooks.get("turn_end")({}, f.ctx);
	if (change === "edit") writeFileSync(f.path, f.plan.replace("first output", "changed requirement"));
	else if (change === "session_tree") f.hooks.get("session_tree")({}, f.ctx);
	else await f.command(change);
	const prepared = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(prepared?.message?.customType).not.toBe("pi-goals-upkeep");
	if (change === "stop") expect(prepared.systemPrompt).toContain("Goal work is paused");
	if (change === "exit") expect(prepared).toBeUndefined();
	expect(f.messages.filter(m => m.message.customType === "pi-goals-upkeep")).toHaveLength(0);
});

it("coalesces pending upkeep with a repaired post-compaction plan, retaining the user's latest requirements", async () => {
	const f = fixture(); await f.draft();
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	for (let i = 0; i < 9; i++) f.hooks.get("turn_end")({}, f.ctx);
	f.hooks.get("session_compact")();
	rmSync(f.path);
	const unavailable = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(unavailable.message).toBeUndefined();
	expect(unavailable.systemPrompt).toContain("unavailable");
	const repaired = f.plan.replace("first output", "the human's latest exact result");
	writeFileSync(f.path, repaired);
	const ready = f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx);
	expect(ready.message).toMatchObject({ customType: "pi-goals-plan" });
	expect(ready.message.content).toContain("the human's latest exact result");
	expect(readFileSync(f.path, "utf8")).toBe(repaired);
	expect(ready.message.content).not.toContain("Plan upkeep:");
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).message).toBeUndefined();
});

it("real SessionManager preserves historical state and restores draft authority before Ready", async () => {
	const f = fixture();
	const session = SessionManager.inMemory(f.ctx.cwd);
	f.pi.appendEntry = (type: string, data: unknown) => { session.appendCustomEntry(type, data); return 0; };
	f.ctx.sessionManager.getBranch = () => session.getBranch();
	await f.draft();
	const latestState = () => session.getBranch().filter(entry => entry.type === "custom" && entry.customType === "pi-goals-main-supervisor-v1").at(-1) as any;
	const planned = latestState();
	await f.command("ready");
	expect(planned.data.mode).toBe("planning");
	expect(latestState().data).not.toBe(planned.data);
	expect(latestState().data.mode).toBe("supervising");
	session.branch(planned.id);
	f.hooks.get("session_tree")({ newLeafId: planned.id }, f.ctx);
	expect(f.start("after-tree")?.block).toBe(true);
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).systemPrompt).toContain("Plan only in");
});

it("serializes CompleteGoal after a real built-in edit without losing either successful update", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	let reportRead!: () => void; const readStarted = new Promise<void>(resolve => { reportRead = resolve; });
	let release!: () => void; const continueRead = new Promise<void>(resolve => { release = resolve; });
	const edit = createEditTool(f.ctx.cwd, { operations: {
		access: path => access(path),
		readFile: async path => { const bytes = await readFile(path); reportRead(); await continueRead; return bytes; },
		writeFile: (path, text) => writeFile(path, text, "utf8"),
	} });
	const editing = edit.execute("edit", { path: f.path, edits: [{ oldText: "# Plan", newText: "# Plan with progress note" }] });
	await readStarted;
	const completing = f.tools.get("CompleteGoal").execute("complete", { goal: "first output", evidence: ["proof.log"], observation: "Read PASS" }, undefined, undefined, f.ctx);
	release();
	await editing; await completing;
	const text = readFileSync(f.path, "utf8");
	expect(text).toContain("# Plan with progress note");
	expect(text).toContain("- [✓] goal: first output");
	expect(text).toContain("Parent review:");
});

it.each(["pause", "replace", "tree", "cancel"])("rejects queued completion after %s while waiting for a file mutation", async change => {
	const f = fixture(); await f.draft(); await f.command("ready");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	let entered!: () => void; const held = new Promise<void>(resolve => { entered = resolve; });
	let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
	const holding = withFileMutationQueue(f.path, async () => { entered(); await wait; });
	await held;
	const abort = new AbortController();
	const completing = f.tools.get("CompleteGoal").execute("complete", { goal: "first output", evidence: ["proof.log"], observation: "Read PASS" }, abort.signal, undefined, f.ctx);
	if (change === "pause") await f.command("stop");
	if (change === "replace") { await f.command("exit"); await f.command("new different output"); }
	if (change === "tree") f.hooks.get("session_tree")({}, f.ctx);
	if (change === "cancel") abort.abort();
	const current = f.entries.at(-1).data.plan;
	const before = readFileSync(current, "utf8");
	release(); await holding;
	const response = await completing;
	expect(response.content[0].text).not.toContain("Recorded parent judgment");
	expect(readFileSync(f.path, "utf8")).toBe(f.plan);
	expect(readFileSync(current, "utf8")).toBe(before);
	expect(readFileSync(f.path, "utf8")).not.toContain("[✓]");
});

it.each([true, false])("solo stop/reload/resume preserves ownership with companion tools=%s", async tools => {
	const f = fixture(); await f.draft();
	if (!tools) f.pi.getAllTools.mockReturnValue([]);
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	await f.command("stop"); await f.command("stop");
	f.hooks.get("session_start")({}, f.ctx);
	expect(f.entries.at(-1).data.pausedFrom).toBe("solo");
	await f.command("resume");
	expect(f.entries.at(-1).data.mode).toBe("solo");
	expect(f.start("forbidden")?.block).toBe(true);
});

it("rejects blank goal subjects on Ready and CompleteGoal", async () => {
	const f = fixture(); await f.draft();
	writeFileSync(f.path, "# Plan\n- [ ] goal: \n- [ ] goal: valid\n## Log\n");
	await f.command("ready");
	expect(f.entries.at(-1).data.mode).toBe("planning");
	writeFileSync(f.path, f.plan); await f.command("ready");
	writeFileSync(f.path, "# Plan\n- [ ] goal: \n## Log\n");
	writeFileSync(join(f.ctx.cwd, "proof.log"), "PASS\n");
	const before = readFileSync(f.path, "utf8");
	await f.tools.get("CompleteGoal").execute("blank", { goal: "  ", evidence: ["proof.log"], observation: "Read PASS" }, undefined, undefined, f.ctx);
	expect(readFileSync(f.path, "utf8")).toBe(before);
	expect(readFileSync(f.path, "utf8")).not.toContain("[✓]");
});

it("passive pause is visible immediately while its model notice waits safely for the next prompt", async () => {
	const f = fixture(); await f.draft();
	f.ctx.ui.select.mockResolvedValueOnce("Worker confirmed stopped"); await f.command("solo");
	await f.command("stop");
	expect(f.messages.at(-1).options).toEqual({ deliverAs: "nextTurn" });
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Remote stop is NOT yet confirmed"), "info");
});

// The native surface has one project binding; these replace old launch-schema/helper tests.
it("opens no-focus, records explicit attachment only, and wakes review only for the exact worker", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	f.channel.listSessions.mockRejectedValueOnce(new Error("Intercom is not connected"));
	const waiting = await f.tools.get("OpenGoalWorker").execute("open", { task: "first" }, undefined, undefined, f.ctx);
	expect(waiting.content[0].text).toContain("still connecting"); expect(openProjectPane).not.toHaveBeenCalled();
	await f.launch({ id: "worker-id", sessionFile: "/tmp/native-worker.jsonl" });
	expect(openProjectPane).toHaveBeenCalledWith(expect.objectContaining({ cwd: f.ctx.cwd, focus: false }));
	expect(vi.mocked(openProjectPane).mock.calls[0][0].message).toContain("WAIT for an explicit assignment");
	const worker = f.entries.at(-1).data.worker;
	expect(worker).toMatchObject({ paneId: "native-pane", intercomId: "worker-id", sessionFile: "/tmp/native-worker.jsonl" });
	expect(f.messages.at(-1)).toMatchObject({ message: { customType: "pi-goals-supervision", display: true, content: expect.stringContaining("Metadata only; no acknowledgement or review turn requested") }, options: { triggerTurn: false } });
	expect(f.messages.at(-1).savedPrompt).toBeUndefined();
	const notice = { type: "stopped", to: worker.parentId, requestId: worker.requestId, plan: f.path, entryId: "revision-1", text: "Blocked: input missing" };
	const count = f.messages.length;
	for (const fromSessionId of [worker.parentId, "foreign-id"]) f.event({ type: "message", fromSessionId, payload: notice });
	f.event({ type: "message", fromSessionId: "worker-id", payload: { ...notice, plan: "/foreign.md" } });
	f.event({ type: "message", fromSessionId: "worker-id", payload: { ...notice, requestId: "stale" } });
	f.event({ type: "message", fromSessionId: "worker-id", payload: { ...notice, entryId: undefined } });
	expect(f.messages).toHaveLength(count);
	f.event({ type: "message", fromSessionId: "worker-id", payload: notice });
	expect(f.messages.at(-2)?.message.content).toContain("Blocked: input missing");
	expect(f.messages.at(-1)?.message.content).toContain("Pending worker revision reviews:");
	const afterFirstRevision = f.messages.length;
	for (const text of ["Done: output.txt", "Error: execution failed"]) f.event({ type: "message", fromSessionId: "worker-id", payload: { ...notice, text } });
	expect(f.messages).toHaveLength(afterFirstRevision);
	expect(readFileSync(f.path, "utf8")).not.toContain("[✓]");
	await f.command("stop");
	f.event({ type: "message", fromSessionId: "worker-id", payload: { ...notice, entryId: "revision-2", text: "New report during pause" } });
	expect(f.messages.at(-1).options).toEqual({ deliverAs: "nextTurn" });
	await f.command("clear");
	const cleared = f.messages.length; f.event({ type: "message", fromSessionId: "worker-id", payload: { ...notice, entryId: "revision-3" } });
	expect(f.messages).toHaveLength(cleared);
});

it("ordinary project peer explicitly attaches as worker, never gaining approval authority", async () => {
	const f = fixture(); const path = join(f.ctx.cwd, "supplied.md"); writeFileSync(path, f.plan);
	Object.assign(f.ctx, { model: { provider: "offline", id: "inherited" } });
	const tool = f.tools.get("AttachGoalPlan");
	await tool.execute("attach", { path }, undefined, undefined, f.ctx);
	expect(f.entries).toHaveLength(0);
	f.channel.listSessions.mockRejectedValueOnce(new Error("Intercom is not connected"));
	const waiting = await tool.execute("attach", { path, parent: "live-parent", requestId: "assignment-id" }, undefined, undefined, f.ctx);
	expect(waiting.content[0].text).toContain("still connecting"); expect(f.entries).toHaveLength(0);
	await tool.execute("attach", { path, parent: "live-parent", requestId: "assignment-id" }, undefined, undefined, f.ctx);
	expect(f.entries.at(-1).data).toMatchObject({ child: true, parent: { intercomId: "live-parent", requestId: "assignment-id" }, plan: path });
	expect(f.channel.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "attached", to: "live-parent", sessionFile: f.ctx.sessionManager.getSessionFile(), identity: expect.objectContaining({ model: "offline/inherited" }) }), { audience: "capable" });
	await f.command("ready"); await f.command("solo");
	const reply = await f.tools.get("CompleteGoal").execute("complete", { goal: "first output", evidence: [path], observation: "claim" }, undefined, undefined, f.ctx);
	expect(reply.content[0].text).toContain("only to the active parent");
	f.hooks.get("session_start")({}, f.ctx); f.hooks.get("session_compact")();
	expect(f.hooks.get("before_agent_start")({ systemPrompt: "base" }, f.ctx).systemPrompt).toContain("delegated implementation worker");
	const assistant = { role: "assistant", content: [{ type: "text", text: "Result at output.txt" }], stopReason: "stop" };
	f.ctx.sessionManager.getBranch().push({ type: "message", id: "saved-report", message: assistant });
	f.hooks.get("agent_end")({ messages: [assistant] }, f.ctx);
	expect(f.channel.publish).toHaveBeenLastCalledWith(expect.objectContaining({ type: "stopped", text: "Result at output.txt" }), { audience: "capable" });
});

it("pending or failed native opening never permits an unconfirmed second writer", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	const tool = f.tools.get("OpenGoalWorker");
	expect(tool.parameters.properties.task.minLength).toBe(1);
	expect((await tool.execute("empty", { task: "" }, undefined, undefined, f.ctx)).content[0].text).toContain("task");
	let release!: () => void;
	vi.mocked(openProjectPane).mockImplementationOnce(() => new Promise((_resolve, reject) => { release = () => reject(new Error("connection lost after open")); }));
	const opening = f.tools.get("OpenGoalWorker").execute("open", { task: "first" }, undefined, undefined, f.ctx);
	await waitFor(() => Boolean(release));
	await f.command("solo");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("still pending"), "warning");
	release(); expect((await opening).content[0].text).toContain("possible live writer");
	const again = await f.tools.get("OpenGoalWorker").execute("open", { task: "again" }, undefined, undefined, f.ctx);
	expect(again.content[0].text).toContain("already recorded");
	expect(openProjectPane).toHaveBeenCalledTimes(1);
});

it("leaves an existing stock pane unbound instead of replacing or retasking it", async () => {
	const f = fixture(); await f.draft(); await f.command("ready");
	vi.mocked(openProjectPane).mockResolvedValueOnce({ ok: true, data: { bindingPath: "/existing/binding.json", disposition: "already-open", binding: { paneId: "existing-pane", projectRoot: f.ctx.cwd, command: "pi" } } });
	const before = f.messages.length;
	const reply = await f.tools.get("OpenGoalWorker").execute("open", { task: "proposed work" }, undefined, undefined, f.ctx);
	expect(reply.content[0].text).toContain("no startup was sent");
	expect(f.entries.at(-1).data.worker).toMatchObject({ paneId: "existing-pane" });
	expect(f.entries.at(-1).data.worker.intercomId).toBeUndefined();
	expect(f.messages).toHaveLength(before);
	expect(f.channel.publish).not.toHaveBeenCalled();
});

it.each(["inherit", "plan", "explicit"])("hands off %s model policy without claiming configuration or invoking an unavailable control", async policy => {
	const f = fixture(); await f.draft();
	if (policy !== "inherit") await f.command("model offline/requested");
	await f.command("ready");
	const model = policy === "explicit" ? "missing/unavailable" : undefined;
	const requested = model ?? (policy === "plan" ? "offline/requested" : undefined);
	await f.tools.get("OpenGoalWorker").execute("open", { task: "bounded work", model }, undefined, undefined, f.ctx);
	const worker = f.entries.at(-1).data.worker;
	expect(worker.intercomId).toBeUndefined();
	const startup = vi.mocked(openProjectPane).mock.calls[0][0].message!;
	expect(startup).toContain(requested ? `User-supplied model preference: ${JSON.stringify(requested)}` : "Inherit the native model");
	if (requested) expect(startup).toContain("Preserve later human model changes");
	expect(vi.mocked(openProjectPane).mock.calls[0][0]).not.toHaveProperty("model");
	const identity = { paneId: "native-pane", sessionId: "worker", sessionFile: "/tmp/worker.jsonl", model: "offline/inherited" };
	f.event({ type: "message", fromSessionId: "worker", payload: { type: "attached", to: worker.parentId, requestId: worker.requestId, plan: f.path, sessionFile: identity.sessionFile, identity } });
	await f.command("status");
	expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Last observed worker model: offline/inherited"), "info");
	if (model) {
		f.event({ type: "message", fromSessionId: "worker", payload: { type: "stopped", to: worker.parentId, requestId: worker.requestId, plan: f.path, entryId: "model-unavailable", text: "Requested missing/unavailable is unavailable; unrelated work can continue." } });
		expect(f.messages.at(-2)?.message.content).toContain("missing/unavailable is unavailable");
		expect(f.messages.at(-1)?.message.content).toContain("Pending worker revision reviews:");
	}

});

it("reviews a saved worker revision through inspection, silent delivery, retry and restored pending reminders", async () => {
	const parent = fixture(), worker = fixture(); await parent.draft(); await parent.command("ready");
	const sm = SessionManager.create(worker.ctx.cwd, join(worker.ctx.cwd, "sessions"));
	worker.ctx.sessionManager = sm as any;
	worker.pi.appendEntry = (type, data) => sm.appendCustomEntry(type, data);
	const workerId = "worker-intercom"; // Broker identity is distinct from the native saved-session UUID.
	parent.channel.publish.mockImplementation(payload => worker.event({ type: "message", fromSessionId: "parent-intercom", payload }));
	worker.channel.publish.mockImplementation(payload => parent.event({ type: "message", fromSessionId: workerId, payload }));
	worker.channel.listSessions.mockResolvedValue([{ id: "parent-intercom", pid: process.pid + 1 }]);
	await parent.tools.get("OpenGoalWorker").execute("open", { task: "Implement first output" }, undefined, undefined, parent.ctx);
	const requestId = parent.entries.at(-1).data.worker.requestId;
	await worker.tools.get("AttachGoalPlan").execute("attach", { path: parent.path, parent: "parent-intercom", requestId }, undefined, undefined, worker.ctx);
	const report = (text: string, stopReason = "stop") => {
		worker.hooks.get("agent_start")({}, worker.ctx);
		const message = { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now(), api: "openai-completions", provider: "offline", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		sm.appendMessage(message as any);
		worker.hooks.get("agent_end")({ messages: [message] }, worker.ctx);
		return `${workerId}:${worker.channel.publish.mock.lastCall?.[0].entryId}`;
	};
	parent.ctx.isIdle.mockReturnValue(false); // Another authorized task is still running.
	const id = report("Output is ready.");
	const before = parent.messages.length;
	await parent.hooks.get("agent_settled")({}, parent.ctx);
	expect(parent.messages).toHaveLength(before + 1);
	await parent.hooks.get("agent_settled")({}, parent.ctx);
	expect(parent.messages).toHaveLength(before + 1); // No self-triggered loop.
	parent.hooks.get("session_start")({}, parent.ctx);
	expect(parent.hooks.get("before_agent_start")({ systemPrompt: "base" }, parent.ctx).systemPrompt).toContain(id);
	const artifact = join(parent.ctx.cwd, "output.txt"); writeFileSync(artifact, "first output\n");
	execFileSync("git", ["init"], { cwd: parent.ctx.cwd });
	execFileSync("git", ["add", "output.txt"], { cwd: parent.ctx.cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "worker evidence"], { cwd: parent.ctx.cwd });
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: parent.ctx.cwd, encoding: "utf8" }).trim();
	writeFileSync(artifact, "changed after reported revision\n");
	const form = { reportId: id, goal: { path: parent.path, quote: "goal: first output" }, evidence: [{ path: `git:${commit}:output.txt`, quote: "invented", observation: "Read the reported revision" }], observation: "Inspected actual output and assigned goal", unmet: "none", verdict: "accepted" };
	const review = () => parent.tools.get("review_subagent").execute("review", form, undefined, undefined, parent.ctx);
	await expect(review()).rejects.toThrow("Quote does not match");
	form.evidence[0].quote = "first output";
	const workerTurns = worker.messages.length;
	parent.channel.publish.mockImplementationOnce(() => {}); // Publish success is not saved delivery.
	await review(); await parent.command("status");
	expect(parent.ctx.ui.notify.mock.lastCall?.[0]).toContain(id);
	expect(parent.ctx.ui.notify.mock.lastCall?.[0]).toContain("Implement first output");
	await review(); await parent.command("status");
	expect(parent.ctx.ui.notify.mock.lastCall?.[0]).toContain("Pending worker revision reviews: none");
	expect(worker.messages).toHaveLength(workerTurns);
	expect(readFileSync(sm.getSessionFile()!, "utf8")).toContain("Worker review: accepted");
	await review(); worker.hooks.get("session_shutdown")();
	parent.event({ type: "session_left", sessionId: workerId });
	await parent.command("status");
	expect(parent.ctx.ui.notify.mock.lastCall?.[0]).toContain("Pending worker revision reviews: none");
	worker.hooks.get("session_start")({}, worker.ctx);
	await parent.command("stop");
	form.reportId = report("Revision failed", "error");
	const paused = parent.messages.length;
	await parent.hooks.get("agent_settled")({}, parent.ctx);
	expect(parent.messages).toHaveLength(paused);
	await parent.command("resume");
	form.verdict = "changes_requested";
	await expect(review()).rejects.toThrow("concrete continuation");
	await parent.tools.get("review_subagent").execute("revision", { ...form, unmet: "Output still needs correction", continuation: "Correct output.txt and rerun verification." }, undefined, undefined, parent.ctx);
	expect(worker.messages.at(-1)).toMatchObject({ savedPrompt: true, message: { content: expect.stringContaining("Correct output.txt") } });
	form.reportId = report("Cancelled while correcting", "aborted"); form.verdict = "blocked";
	await review(); await parent.command("status");
	expect(parent.ctx.ui.notify.mock.lastCall?.[0]).toContain("Pending worker revision reviews: none");
	expect(readFileSync(parent.path, "utf8")).not.toContain("[✓]");

	// Lost notification and cancellation before any new assistant message: durable run identity.
	worker.hooks.get("agent_start")({}, worker.ctx);
	worker.channel.publish.mockImplementationOnce(() => {});
	worker.hooks.get("agent_end")({ messages: [] }, worker.ctx);
	const missed = `${workerId}:${worker.channel.publish.mock.lastCall?.[0].entryId}`;
	expect(missed).not.toBe(form.reportId);
	// Same preserved worker, newly approved plan and request: old reviews stay in history.
	const history = sm.getBranch(), oldPlan = readFileSync(parent.path, "utf8");
	await parent.command("clear"); await parent.command("new Next output");
	const nextPlan = parent.entries.at(-1).data.plan; writeFileSync(nextPlan, parent.plan);
	await parent.command("ready");
	await parent.tools.get("OpenGoalWorker").execute("next", { task: "Implement next output" }, undefined, undefined, parent.ctx);
	const nextRequest = parent.entries.at(-1).data.worker.requestId;
	const attach = (params: object) => worker.tools.get("AttachGoalPlan").execute("reattach", params, undefined, undefined, worker.ctx);
	const unchanged = () => expect(sm.getBranch()).toEqual(history);
	expect((await attach({ path: nextPlan })).content[0].text).toContain("explicit authorization"); unchanged();
	worker.channel.listSessions.mockResolvedValue([{ id: "parent-intercom", pid: process.pid + 1 }, { id: "foreign-parent", pid: process.pid + 2 }]);
	expect((await attach({ path: nextPlan, parent: "foreign-parent", requestId: nextRequest })).content[0].text).toContain("Different-parent takeover"); unchanged();
	worker.channel.listSessions.mockRejectedValueOnce(new Error("offline"));
	expect((await attach({ path: nextPlan, parent: "parent-intercom", requestId: nextRequest })).content[0].text).toContain("still connecting"); unchanged();
	await attach({ path: nextPlan, parent: "parent-intercom", requestId: nextRequest });
	expect(parent.entries.at(-1).data.worker).toMatchObject({ intercomId: workerId, requestId: nextRequest, sessionFile: sm.getSessionFile() });
	expect(sm.getBranch().slice(0, history.length)).toEqual(history);
	await attach({ path: nextPlan }); // Context restoration does not require new authorization.
	const nextReport = report("New-plan output needs inspection");
	await parent.command("status");
	expect(parent.ctx.ui.notify.mock.lastCall?.[0]).toContain(nextReport);
	expect(worker.channel.publish.mock.lastCall?.[0]).toMatchObject({ type: "stopped", plan: nextPlan, requestId: nextRequest });
	parent.hooks.get("session_start")({}, parent.ctx); // Reconcile the missed stop from real saved worker history.
	await parent.command("status");
	expect(parent.ctx.ui.notify.mock.lastCall?.[0]).toContain(missed);
	form.reportId = missed; await review(); // Old-plan blocked review remains deliverable after retargeting.
	await parent.command("status");
	expect(parent.ctx.ui.notify.mock.lastCall?.[0]).not.toContain(missed);
	expect(parent.ctx.ui.notify.mock.lastCall?.[0]).toContain(nextReport);
	const ordinary = (id: string, text: string, links = {}, sender = workerId) => {
		const details = { from: { id: sender }, message: { id, timestamp: Date.now(), content: { text }, ...links } };
		parent.ctx.sessionManager.getBranch().push({ type: "custom_message", id, customType: "intercom_message", content: text, details });
		parent.hooks.get("message_end")({ message: { role: "custom", customType: "intercom_message", content: text, details } }, parent.ctx);
	};
	ordinary("ordinary-a", "Partial output needs review");
	ordinary("ordinary-b", "Corrected output needs review", { supersedes: "ordinary-a" });
	ordinary("retry-b", "Corrected output needs review", { retryOf: "ordinary-b" });
	ordinary("retry-again", "Corrected output needs review", { retryOf: "retry-b" });
	ordinary("ack-only", "OK"); ordinary("foreign", "Unowned report", {}, "foreign-peer");
	parent.hooks.get("session_start")({}, parent.ctx); await parent.command("status");
	const pending = parent.ctx.ui.notify.mock.lastCall?.[0];
	for (const nonReviewable of ["ordinary-a", "ordinary-b", "retry-b", "retry-again", "ack-only", "foreign-peer"]) expect(pending).not.toContain(nonReviewable);
	expect(pending).toContain(nextReport);
	expect(readFileSync(parent.path, "utf8")).toBe(oldPlan);
	expect((await worker.tools.get("CompleteGoal").execute("deny", { goal: "first output", evidence: [], observation: "claim" }, undefined, undefined, worker.ctx)).content[0].text).toContain("only to the active parent");
});
