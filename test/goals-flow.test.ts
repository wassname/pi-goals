import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalPath, goalBlock, hashGoalBlock, repositoryState, writeApproval } from "../src/approval.js";
import { GoalIntercom } from "../src/intercom.js";
import { intercomFixture } from "./intercom-fixture.js";
import { pairedIntercomFixture } from "./paired-intercom-fixture.js";

const openSupervisorPane = vi.fn(async () => "pane-2");
const closeSupervisorPane = vi.fn(async () => undefined);
const shutdowns: Array<() => Promise<void>> = [];
vi.mock("../src/herdr.js", () => ({ openSupervisorPane, closeSupervisorPane }));
const { default: piGoalsExtension, isMainSession } = await import("../src/index.js");

function setup(selectChoices: Array<string | undefined>, editorChoices: Array<string | undefined> = [], events?: ExtensionAPI["events"]) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-flow-"));
	writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
	writeFileSync(join(cwd, "verify.txt"), "PASS\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", ".gitignore", "verify.txt"], { cwd });
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
	const transport = intercomFixture();
	const commands = new Map<string, any>();
	const hooks = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const messages: Array<{ content: string; display?: boolean }> = [];
	const notifications: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: vi.fn(() => true),
		getSystemPrompt: () => "base prompt",
		model: { provider: "test", id: "tiny" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: {
			getSessionId: () => "session-a",
			getSessionFile: () => join(cwd, "session.jsonl"),
			getEntries: () => entries,
			getBranch: () => [],
		},
		ui: {
			theme: { fg: (_kind: string, text: string) => text },
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			notify: (text: string) => notifications.push(text),
			select: async () => selectChoices.shift(),
			editor: async () => editorChoices.shift(),
		},
	};
	openSupervisorPane.mockImplementation(async () => "pane-2");
	const pi = {
		events: events ?? transport.events,
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => {
			const prior = hooks.get(name);
			hooks.set(name, async (...args: any[]) => { await prior?.(...args); return handler(...args); });
		},
		appendEntry: (customType: string, data: unknown) => { if (customType === "pi-goals-state") entries.push({ type: "custom", customType, data }); },
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getAllTools: () => [],
		setModel: vi.fn(async () => true),
		sendMessage: (message: { content: string; display?: boolean }) => messages.push(message),
		sendUserMessage: (content: string) => messages.push({ content }),
	};
	piGoalsExtension(pi as unknown as ExtensionAPI);
	shutdowns.push(() => hooks.get("session_shutdown")());
	return { pi, commands, ctx, cwd, entries, hooks, messages, notifications, tools, transport };
}

function writePlan(cwd: string, content: string): string {
	const path = join(cwd, ".pi/plan/session-a-v1.md");
	mkdirSync(join(cwd, ".pi/plan"), { recursive: true });
	writeFileSync(path, content);
	return path;
}

function approvedPlan(cwd: string): string {
	return writePlan(cwd, "# Plan\n\n## Goals\n\n1. [ ] goal: make the file\n  - discriminator: output exists\n  - evidence:\n    - `result.txt`: contains ok\n\n## Log\n");
}

afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	vi.useRealTimers();
	openSupervisorPane.mockClear();
	closeSupervisorPane.mockClear();
});

describe("/goals flow", () => {
	it("reports actual idle state, invalidates stopped views on start, and stops completed plans", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const path = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			const views = () => flow.transport.sent.filter(message => message.kind === "view");
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(views().at(-1)?.text).toMatch(/^The worker stopped\./);
			flow.ctx.isIdle.mockReturnValue(false);
			await flow.hooks.get("agent_start")({}, flow.ctx);
			expect(views().at(-1)?.text).toMatch(/^The worker is still working\./);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(views().at(-1)?.text).toMatch(/^The worker is still working\./);
			flow.ctx.isIdle.mockReturnValue(true);
			writeFileSync(path, readFileSync(path, "utf8").replace("[ ] goal:", "[x] goal:"));
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			const count = views().length;
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null });
			const binding = (flow.entries.at(-1)?.data as any).approvalId;
			const messageCount = flow.messages.length;
			flow.transport.receive({ binding, role: "supervisor", kind: "steer", id: "late-completed", text: "Obsolete instruction." });
			await flow.commands.get("goals").handler("restart", flow.ctx);
			await flow.commands.get("goals").handler("reconnect", flow.ctx);
			expect(flow.messages).toHaveLength(messageCount);
			expect(openSupervisorPane).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(views()).toHaveLength(count);
		} finally {
			await flow.hooks.get("session_shutdown")();
			vi.useRealTimers();
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});
	it("preserves drafts, records the interview, and keeps planning read-only", async () => {
		const flow = setup(["Refine"], ["Keep two columns."]);
		try {
			await flow.commands.get("goals").handler("first objective", flow.ctx);
			const first = writePlan(flow.cwd, "# Plan\n\n## Goals\n\n1. [ ] goal: preserve this\n\n## Interview\n");
			await flow.hooks.get("input")({ text: "Preserve column order.", source: "interactive" }, flow.ctx);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(readFileSync(first, "utf8")).toContain("> Preserve column order.");
			expect(readFileSync(first, "utf8")).toContain("> Keep two columns.");
			expect(flow.messages.at(-1)?.content).toContain("Revise the plan at");
			expect((await flow.hooks.get("tool_call")({ toolName: "edit", input: { path: "README.md" } }, flow.ctx))?.block).toBe(true);

			await flow.commands.get("goals").handler("second objective", flow.ctx);
			expect(readFileSync(first, "utf8")).toContain("preserve this");
			expect(flow.messages.at(-1)?.content).toContain("session-a-v2.md");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("forks a visible supervisor on Ready and keeps the main session as worker", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const planPath = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(openSupervisorPane).toHaveBeenCalledWith(expect.objectContaining({
				cwd: flow.cwd,
				sourceSessionFile: join(flow.cwd, "session.jsonl"),
				workerSessionId: "session-a",
				planPath,
			}), expect.any(Function));
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", supervisorPaneId: "pane-2" });
			expect(flow.messages.at(-1)?.content).toBe("The plan is approved. Begin implementation as the worker.");
			const prompt = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(prompt.systemPrompt).toContain("implementation worker");
			expect(prompt.systemPrompt).toContain("stronger read-only supervisor");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("starts work only after the supervisor launcher resolves", async () => {
		const flow = setup(["Ready"]);
		try {
			let ready: (() => void) | undefined;
			openSupervisorPane.mockImplementationOnce(() => new Promise((resolve) => { ready = () => resolve("pane-2"); }));
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			approvedPlan(flow.cwd);
			const starting = flow.hooks.get("agent_settled")({}, flow.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning" });
			ready!();
			await starting;
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", supervisorPaneId: "pane-2" });
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("delivers an Intercom instruction to the worker",  async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			const binding = (flow.entries.at(-1)?.data as { approvalId: string }).approvalId;
			flow.transport.receive({ binding, role: "supervisor", kind: "steer", id: "steer-1", text: "Run the focused test." });
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(flow.messages.some((message) => message.content === "[supervisor] Run the focused test.")).toBe(true);
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("closes the supervisor on clear but keeps the plan file", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const planPath = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			const binding = (flow.entries.at(-1)?.data as any).approvalId;
			await flow.commands.get("goals").handler("clear", flow.ctx);
			const messageCount = flow.messages.length;
			flow.transport.receive({ binding, role: "supervisor", kind: "steer", id: "late-cleared", text: "Obsolete instruction." });
			await flow.commands.get("goals").handler("restart", flow.ctx);
			await flow.commands.get("goals").handler("reconnect", flow.ctx);
			expect(flow.messages).toHaveLength(messageCount);
			expect(openSupervisorPane).toHaveBeenCalledTimes(1);
			expect(closeSupervisorPane).toHaveBeenCalledWith("pane-2");
			expect(readFileSync(planPath, "utf8")).toContain("make the file");
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, supervisorPaneId: null, planVersion: null });
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("accepts only an approval for the exact clean commit and goal block", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const planPath = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			const goal = "make the file";
			const plan = readFileSync(planPath, "utf8");
			const block = goalBlock(plan, goal)!;
			const repository = repositoryState(flow.cwd);
			const approvalId = (flow.entries.at(-1)?.data as { approvalId: string }).approvalId;
			writeApproval(approvalPath(flow.cwd, "session-a", goal), {
				version: 3, verdict: "accept", approvalId, goal, planPath,
				goalBlockHash: hashGoalBlock(block), repoRoot: repository.repoRoot,
				head: repository.head, tree: repository.tree, cleanWorktree: true,
				inspected: { plan: true, repository: true, evidence: true, verifyOutput: true },
				verifyOutputPath: "verify.txt",
				supervisor: { sessionId: "supervisor", runId: null }, timestamp: new Date().toISOString(),
			});
			writeFileSync(planPath, `${plan}- Appended manual log after approval.\n1. [ ] goal: make the file\n2. [ ] goal: historical only\n`);
			const signed = await flow.tools.get("CompleteGoal").execute("id", { goal }, undefined, undefined, flow.ctx);
			expect(signed.isError).toBe(false);
			expect(readFileSync(planPath, "utf8")).toContain("1. [x] goal: make the file");
			expect(readFileSync(planPath, "utf8")).toContain("1. [ ] goal: make the file");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null });
			expect(flow.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-goals-widget", ["✔ complete"]);
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});
});

describe("process role", () => {
	it("keeps subagent children and visible supervisors out of the worker extension", () => {
		expect(isMainSession(false)).toBe(true);
		expect(isMainSession(true)).toBe(false);
	});
});

function restoredPlan(flow: ReturnType<typeof setup>, phase: "working" | "planning" = "working") {
	const path = approvedPlan(flow.cwd);
	flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase, approvalId: "restored-binding", supervisorPaneId: "owned-pane", planVersion: 1 } });
	return path;
}

it.each(["working", "planning"] as const)("restores %s linkage even when its remembered model is unavailable, and supports explicit recovery", async phase => {
	const flow = setup([]);
	try {
		const path = restoredPlan(flow, phase);
		const plan = readFileSync(path, "utf8");
		const role = phase === "working" ? "worker" : "planning";
		mkdirSync(join(flow.cwd, ".pi/pi-goals/models"), { recursive: true });
		const modelPath = join(flow.cwd, `.pi/pi-goals/models/${role}.json`);
		writeFileSync(modelPath, JSON.stringify({ provider: "gone", id: "expired" }));
		flow.ctx.modelRegistry.find = vi.fn().mockReturnValue(undefined);
		await expect(flow.hooks.get("session_start")({}, flow.ctx)).resolves.toBeUndefined();
		expect(flow.pi.setModel).not.toHaveBeenCalled();
		expect(readFileSync(modelPath, "utf8")).toContain("expired");
		expect(flow.transport.sent.filter(message => message.kind === "hello" && message.ready)).toHaveLength(0);
		expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", "goals paused");
		if (phase === "working") expect(flow.transport.sent).toContainEqual(expect.objectContaining({ kind: "hello", binding: "restored-binding" }));
		expect((await flow.hooks.get("tool_call")({ toolName: "edit", input: { path: "code.ts" } }, flow.ctx)).block).toBe(true);
		expect(await flow.hooks.get("tool_call")({ toolName: "read", input: { path: "code.ts" } }, flow.ctx)).toBeUndefined();
		expect(await flow.hooks.get("input")({ source: "interactive", text: "Why are we paused?" }, flow.ctx)).toBeUndefined();
		const signoff = await flow.tools.get("CompleteGoal").execute("id", { goal: "make the file" }, undefined, undefined, flow.ctx);
		expect(signoff.isError).toBe(true);
		flow.ctx.modelRegistry.find = (provider, id) => ({ provider, id });
		await flow.hooks.get("model_select")({ source: "set", model: { provider: "test", id: "chosen" } }, flow.ctx);
		await flow.commands.get("goals").handler("reconnect", flow.ctx);
		expect(flow.pi.setModel).toHaveBeenLastCalledWith({ provider: "test", id: "chosen" });
		expect(openSupervisorPane).not.toHaveBeenCalled();
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase, approvalId: "restored-binding", planVersion: 1 });
		const injection = await flow.hooks.get("before_agent_start")({}, flow.ctx);
		if (phase === "planning") expect(injection.message.content).toContain(path);
		else expect(injection.systemPrompt).toContain("implementation worker");
		// Human diagnostic input is retained in the planning interview, never discarded by recovery.
		expect(readFileSync(path, "utf8")).toContain(plan.trim());
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("shows a missing resumed supervisor, pauses writes, and automatically unpauses when that peer returns", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	const flow = setup([]);
	try {
		restoredPlan(flow);
		flow.transport.replyToHello(false);
		await flow.hooks.get("session_start")({}, flow.ctx);
		expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", "goals paused");
		await vi.advanceTimersByTimeAsync(5000);
		expect(flow.notifications.some(text => text.includes("/goals restart"))).toBe(true);
		expect((await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "code.ts" } }, flow.ctx)).terminate).toBe(true);
		expect(await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, flow.ctx)).toBeUndefined();
		flow.transport.receive({ binding: "restored-binding", role: "supervisor", kind: "hello", id: "hello", ready: true });
		expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("supervised"));
		expect(await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "code.ts" } }, flow.ctx)).toBeUndefined();
		expect(openSupervisorPane).not.toHaveBeenCalled();
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("times out stale Ready retries in five seconds, without replacing the pane automatically", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	const flow = setup(["Ready", "Ready"]);
	try {
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		approvedPlan(flow.cwd);
		flow.transport.replyToHello(false);
		openSupervisorPane.mockImplementationOnce(async (_input: any, opened: any) => { opened("failed-pane"); throw new Error("pane run failed"); });
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		expect(flow.notifications.at(-1)).toContain("failed-pane");
		const retry = flow.hooks.get("agent_settled")({}, flow.ctx);
		await vi.advanceTimersByTimeAsync(5000);
		await retry;
		expect(openSupervisorPane).toHaveBeenCalledTimes(1);
		expect(closeSupervisorPane).not.toHaveBeenCalled();
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", supervisorPaneId: "failed-pane" });
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("explicitly restarts only the tracked pane, keeps the plan, and invalidates old approval binding", async () => {
	const flow = setup([]);
	try {
		const path = restoredPlan(flow);
		const before = readFileSync(path, "utf8");
		await flow.hooks.get("session_start")({}, flow.ctx);
		const checkpoint = approvalPath(flow.cwd, "session-a", "make the file");
		mkdirSync(join(flow.cwd, ".pi/pi-goals/approvals"), { recursive: true });
		writeFileSync(checkpoint, "old checkpoint");
		await flow.commands.get("goals").handler("restart", flow.ctx);
		expect(closeSupervisorPane).toHaveBeenCalledExactlyOnceWith("owned-pane");
		expect(openSupervisorPane).toHaveBeenCalledTimes(1);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", planVersion: 1 });
		expect((flow.entries.at(-1)?.data as any).approvalId).not.toBe("restored-binding");
		expect(() => readFileSync(checkpoint)).toThrow();
		await flow.commands.get("goals").handler("clear", flow.ctx);
		expect(await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "unrelated.ts" } }, flow.ctx)).toBeUndefined();
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("does not persist startup results or launch work after session shutdown", async () => {
	const flow = setup(["Ready"]);
	try {
		let finish: (() => void) | undefined;
		openSupervisorPane.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve("late-pane"); }));
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		approvedPlan(flow.cwd);
		const starting = flow.hooks.get("agent_settled")({}, flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		await flow.hooks.get("session_shutdown")();
		const entries = flow.entries.length;
		const messages = flow.messages.length;
		finish!();
		await starting;
		expect(flow.entries).toHaveLength(entries);
		expect(flow.messages).toHaveLength(messages);
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("keeps a failed Ready model not-ready and recovers the same real supervisor binding", async () => {
	const wire = pairedIntercomFixture();
	const flow = setup(["Ready", "Ready"], [], wire.worker.events as ExtensionAPI["events"]);
	const supervisorEntries: any[] = [];
	const supervisor = new GoalIntercom({ events: wire.supervisor.events, on: () => {}, appendEntry: (customType: string, data: unknown) => supervisorEntries.push({ type: "custom", customType, data }) } as unknown as ExtensionAPI);
	const supervisorCtx = { sessionManager: { getEntries: () => supervisorEntries }, ui: { notify: vi.fn() } };
	try {
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		approvedPlan(flow.cwd);
		mkdirSync(join(flow.cwd, ".pi/pi-goals/models"), { recursive: true });
		writeFileSync(join(flow.cwd, ".pi/pi-goals/models/worker.json"), JSON.stringify({ provider: "gone", id: "expired" }));
		flow.ctx.modelRegistry.find = () => undefined as any;
		openSupervisorPane.mockImplementationOnce(async (input: any) => {
			supervisor.configure(input.approvalId, "supervisor", supervisorCtx as any, true);
			return "pane-2";
		});
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		const binding = (flow.entries.at(-1)?.data as any).approvalId;
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", planVersion: 1 });
		expect(wire.worker.sent.filter(message => message.kind === "hello" && message.ready)).toHaveLength(0);
		expect(supervisor.connected).toBe(false);
		expect(() => supervisor.steer("Must wait.")).toThrow("disconnected");
		await flow.hooks.get("model_select")({ source: "set", model: { provider: "test", id: "chosen" } }, flow.ctx);
		flow.ctx.modelRegistry.find = (provider, id) => ({ provider, id });
		await flow.commands.get("goals").handler("reconnect", flow.ctx);
		expect(supervisor.connected).toBe(false); // Planning is not implementation readiness.
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		expect(supervisor.connected).toBe(true);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", approvalId: binding, planVersion: 1 });
		expect(openSupervisorPane).toHaveBeenCalledTimes(1);
		expect(closeSupervisorPane).not.toHaveBeenCalled();
		await flow.commands.get("goals").handler("reconnect", flow.ctx);
		supervisor.steer("Recovered instruction.");
		await new Promise(resolve => setImmediate(resolve));
		expect(flow.messages.filter(message => message.content === "[supervisor] Recovered instruction.")).toHaveLength(1);
		expect(supervisorCtx.ui.notify).not.toHaveBeenCalled();
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("points a present-but-paused peer recovery at the supervisor pane", async () => {
	const flow = setup([]);
	try {
		restoredPlan(flow);
		await flow.hooks.get("session_start")({}, flow.ctx);
		flow.transport.replyToHello(false);
		flow.transport.receive({ binding: "restored-binding", role: "supervisor", kind: "hello", id: "hello", ready: false });
		expect(flow.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-goals-widget", [expect.stringContaining("Supervisor is present but not ready")]);
		const prompt = await flow.hooks.get("before_agent_start")({}, flow.ctx);
		expect(prompt.systemPrompt).toContain("/goals reconnect in the supervisor pane");
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("clear during the initial Ready wait cancels immediately and cannot resurrect the plan", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	const flow = setup(["Ready"]);
	try {
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		const path = approvedPlan(flow.cwd);
		flow.transport.replyToHello(false);
		const starting = flow.hooks.get("agent_settled")({}, flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		expect(flow.entries.at(-1)?.data).toMatchObject({ supervisorPaneId: "pane-2" });
		await flow.commands.get("goals").handler("clear", flow.ctx);
		await starting; // No timer advancement: detach must cancel the five-minute wait.
		const entryCount = flow.entries.length;
		await vi.advanceTimersByTimeAsync(300_000);
		expect(flow.entries).toHaveLength(entryCount);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, planVersion: null, approvalId: null });
		expect(flow.messages.some(message => message.content.includes("Begin implementation"))).toBe(false);
		expect(flow.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-goals-widget", undefined);
		expect(readFileSync(path, "utf8")).toContain("make the file");
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("clear before the launcher resolves rejects late pane callbacks without restoring the binding", async () => {
	const flow = setup(["Ready"]);
	try {
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		approvedPlan(flow.cwd);
		let finish!: () => void;
		openSupervisorPane.mockImplementationOnce((_input: any, opened: any) => new Promise((resolve, reject) => {
			finish = () => { try { opened("late-pane"); resolve("late-pane"); } catch (error) { reject(error); } };
		}));
		const starting = flow.hooks.get("agent_settled")({}, flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		await flow.commands.get("goals").handler("clear", flow.ctx);
		const entryCount = flow.entries.length;
		finish(); await starting;
		expect(flow.entries).toHaveLength(entryCount);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, planVersion: null, approvalId: null });
		expect(flow.messages.some(message => message.content.includes("Begin implementation"))).toBe(false);
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});
