import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
const { registerWorker: piGoalsExtension, isMainSession } = await import("../src/index.js");

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
		getContextUsage: () => ({ percent: 25 }),
		compact: vi.fn((options: { onComplete?: () => void }) => options.onComplete?.()),
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
	openSupervisorPane.mockReset();
	closeSupervisorPane.mockClear();
});

describe("/goals flow", () => {
	it("reports idleness and keeps manual completion claims supervised without reverting edits", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const path = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			const views = () => flow.transport.sent.filter(message => message.kind === "view");
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(views().at(-1)?.text).toMatch(/^The worker stopped\./);
			writeFileSync(path, readFileSync(path, "utf8").replace("[ ] goal:", "[/] goal:"));
			flow.ctx.isIdle.mockReturnValue(false);
			await flow.hooks.get("agent_start")({}, flow.ctx);
			expect(views().at(-1)?.text).toMatch(/^The worker is still working\./);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(views().at(-1)?.text).toMatch(/^The worker is still working\./);
			flow.ctx.isIdle.mockReturnValue(true);
			writeFileSync(path, readFileSync(path, "utf8").replace("[/] goal:", "[x] goal:"));
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.hooks.get("turn_end")({}, flow.ctx);
			const count = views().length;
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", signedOffGoals: [] });
			expect(views().at(-1)?.text).toContain("make the file: [/] -> [x]; manual completion claim, no CompleteGoal sign-off recorded");
			expect(views().at(-1)?.text).toContain("use SteerWorker to send the next useful instruction and resume work");
			expect(views().at(-1)?.text).toContain("Manual checkbox edits are claims, not proof of completion");
			expect(readFileSync(path, "utf8")).toContain("[x] goal:");
			expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("0/1 goals · supervised worker · 1 claimed, awaiting review"));
			expect(flow.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-goals-widget", [expect.stringContaining("claimed complete; awaiting supervisor review")]);
			const binding = (flow.entries.at(-1)?.data as any).approvalId;
			flow.transport.receive({ binding, role: "supervisor", kind: "steer", id: "review-claim", text: "Reopen the goal; verify the missing output first." });
			expect(flow.messages.at(-1)?.content).toBe("[supervisor] Reopen the goal; verify the missing output first.");
			await flow.hooks.get("session_start")({}, flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", signedOffGoals: [] });
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(views().length).toBeGreaterThan(count);
		} finally {
			await flow.hooks.get("session_shutdown")();
			vi.useRealTimers();
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});
	it("wakes review for an external non-checkbox plan edit, including atomic replacement", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const path = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			const before = readFileSync(path, "utf8");
			writeFileSync(`${path}.tmp`, before.replace("output exists", "output contains exact required bytes"));
			renameSync(`${path}.tmp`, path);
			await vi.waitFor(() => {
				const view = flow.transport.sent.filter(message => message.kind === "view").at(-1);
				expect(view?.reason).toBe("plan");
				expect(view?.text).toContain("Assess plan changes against the user's intent and preferences");
				expect(view?.text).toContain("-   - discriminator: output exists");
				expect(view?.text).toContain("+   - discriminator: output contains exact required bytes");
			});
			const count = flow.transport.sent.length;
			await flow.hooks.get("session_shutdown")();
			writeFileSync(path, before);
			await new Promise(resolve => setTimeout(resolve, 250));
			expect(flow.transport.sent).toHaveLength(count);
		} finally { await flow.hooks.get("session_shutdown")(); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("coalesces active-worker plan edits into its settled review", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			const path = approvedPlan(flow.cwd);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			flow.ctx.isIdle.mockReturnValue(false);
			const before = readFileSync(path, "utf8");
			writeFileSync(path, before.replace("output exists", "intermediate discriminator"));
			writeFileSync(path, before.replace("output exists", "final discriminator"));
			await new Promise(resolve => setTimeout(resolve, 250));
			expect(flow.transport.sent.filter(message => message.kind === "view" && message.reason === "plan")).toHaveLength(0);
			flow.ctx.isIdle.mockReturnValue(true);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			const view = flow.transport.sent.filter(message => message.kind === "view").at(-1);
			expect(view?.text).toContain("-   - discriminator: output exists");
			expect(view?.text).toContain("+   - discriminator: final discriminator");
			expect(view?.text).not.toContain("intermediate discriminator");
		} finally { await flow.hooks.get("session_shutdown")(); rmSync(flow.cwd, { recursive: true, force: true }); }
	});

	it("restores sign-off markers but clears one when a goal is reopened", async () => {
		const flow = setup([]);
		try {
			const path = writePlan(flow.cwd, "1. [x] goal: first\n2. [ ] goal: second\n");
			flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", approvalId: "binding", planVersion: 1, signedOffGoals: ["first"], previousPlan: readFileSync(path, "utf8") } });
			await flow.hooks.get("session_start")({}, flow.ctx);
			expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("1/2 goals"));
			writeFileSync(path, "1. [/] goal: first\n2. [ ] goal: second\n");
			await flow.hooks.get("turn_end")({}, flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ signedOffGoals: [] });
			writeFileSync(path, "1. [x] goal: first\n2. [ ] goal: second\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.hooks.get("turn_end")({}, flow.ctx);
			expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("0/2 goals · supervised worker · 1 claimed, awaiting review"));
		} finally { await flow.hooks.get("session_shutdown")(); rmSync(flow.cwd, { recursive: true, force: true }); }
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

			await flow.commands.get("goals").handler("plan second objective", flow.ctx);
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
			const controller = new AbortController();
			const beforeCancel = readFileSync(planPath, "utf8");
			const cancelled = flow.tools.get("CompleteGoal").execute("cancelled", { goal }, controller.signal, undefined, flow.ctx);
			controller.abort(); // Cancel while the background-state lookup yields.
			expect((await cancelled).isError).toBe(true);
			expect(readFileSync(planPath, "utf8")).toBe(beforeCancel);
			expect((await flow.tools.get("CompleteGoal").execute("already-cancelled", { goal }, controller.signal, undefined, flow.ctx)).isError).toBe(true);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", signedOffGoals: [] });
			const signed = await flow.tools.get("CompleteGoal").execute("id", { goal }, undefined, undefined, flow.ctx);
			expect(signed.isError).toBe(false);
			expect(readFileSync(planPath, "utf8")).toContain("1. [x] goal: make the file");
			expect(readFileSync(planPath, "utf8")).toContain("1. [ ] goal: make the file");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", approvalId, signedOffGoals: [goal] });
			expect(flow.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-goals-widget", ["✔ complete"]);
			flow.transport.receive({ binding: approvalId, role: "supervisor", kind: "steer", id: "post-signoff", text: "Inspect the late finding." });
			expect(flow.messages.at(-1)?.content).toBe("[supervisor] Inspect the late finding.");
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
		await vi.advanceTimersByTimeAsync(60_000);
		expect(flow.notifications.some(text => text.includes("/goals restart"))).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(flow.notifications.some(text => text.includes("UNSUPERVISED"))).toBe(false);
		expect((await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "code.ts" } }, flow.ctx)).terminate).toBe(true);
		expect(await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, flow.ctx)).toBeUndefined();
		flow.transport.receive({ binding: "restored-binding", role: "supervisor", kind: "hello", id: "hello", ready: true });
		expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("supervised"));
		expect(await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "code.ts" } }, flow.ctx)).toBeUndefined();
		expect(openSupervisorPane).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(flow.notifications.some(text => text.includes("UNSUPERVISED WORKER"))).toBe(false);
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("restores planning context after a Ready compaction failure", async () => {
	const flow = setup(["Ready"]);
	try {
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		approvedPlan(flow.cwd);
		await flow.hooks.get("before_agent_start")({}, flow.ctx);
		flow.ctx.compact.mockImplementationOnce((options: { onError?: (error: Error) => void }) => options.onError?.(new Error("Compaction cancelled")));
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning" });
		await flow.hooks.get("session_compact")({}, flow.ctx);
		expect(await flow.hooks.get("before_agent_start")({}, flow.ctx)).toMatchObject({ message: expect.objectContaining({ customType: "pi-goals-planning-context" }) });
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("restores planning context after a successful Ready compaction later loses its worker model", async () => {
	const flow = setup(["Ready"]);
	try {
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		approvedPlan(flow.cwd);
		flow.pi.setModel.mockResolvedValueOnce(false);
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning" });
		await flow.commands.get("goals").handler("reconnect", flow.ctx);
		expect(await flow.hooks.get("before_agent_start")({}, flow.ctx)).toMatchObject({ message: expect.objectContaining({ customType: "pi-goals-planning-context" }) });
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("does not enter solo when a completed pairing resumes without its supervisor", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	const flow = setup([]);
	try {
		const path = writePlan(flow.cwd, "# Plan\n\n## Goals\n\n1. [x] goal: make the file\n\n## Log\n");
		flow.entries.push({ type: "custom", customType: "pi-goals-state", data: { phase: "working", mode: "supervised", approvalId: "restored-binding", supervisorPaneId: "owned-pane", planVersion: 1, signedOffGoals: ["make the file"] } });
		flow.transport.replyToHello(false);
		await flow.hooks.get("session_start")({}, flow.ctx);
		await vi.advanceTimersByTimeAsync(310_000);
		expect(readFileSync(path, "utf8")).toContain("[x] goal: make the file");
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", mode: "supervised", approvalId: "restored-binding" });
		expect(flow.notifications.some(text => text.includes("UNSUPERVISED WORKER"))).toBe(false);
		expect(flow.messages.some(message => message.content.startsWith("UNSUPERVISED WORKER"))).toBe(false);
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("exits planning without deleting the draft or approving implementation", async () => {
	const flow = setup([]);
	try {
		await flow.commands.get("goals").handler("draft", flow.ctx);
		const path = approvedPlan(flow.cwd);
		const before = readFileSync(path, "utf8");
		await flow.commands.get("goals").handler("noplan", flow.ctx);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, planVersion: 1 });
		expect(openSupervisorPane).not.toHaveBeenCalled();
		expect(flow.messages.some(message => message.content.includes("Begin implementation"))).toBe(false);
		await flow.hooks.get("session_compact")({}, flow.ctx);
		expect(await flow.hooks.get("context")({ messages: [] }, flow.ctx)).toBeUndefined();
		expect(await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "arbitrary.txt" } }, flow.ctx)).toBeUndefined();
		await flow.commands.get("goals").handler("work", flow.ctx);
		expect(flow.notifications.at(-1)).toContain("No approved worker pairing");
		await flow.commands.get("goals").handler("supervise", flow.ctx);
		expect(flow.notifications.at(-1)).toContain("worker session");
		expect(openSupervisorPane).not.toHaveBeenCalled();
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("publishes one fresh view after an accepted-view peer reload, but never after clear", async () => {
	const flow = setup(["Ready"]);
	try {
		await flow.commands.get("goals").handler("draft", flow.ctx);
		const path = approvedPlan(flow.cwd);
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		const views = () => flow.transport.sent.filter(message => message.kind === "view");
		const original = views().at(-1)!;
		flow.transport.receive({ binding: original.binding, role: "supervisor", kind: "received", id: original.id });
		flow.transport.event({ type: "session_left", sessionId: "peer" });
		writeFileSync(path, readFileSync(path, "utf8").replace("output exists", "current result must exist"));
		const previousIds = new Set(views().map(view => view.id));
		flow.transport.receive({ binding: original.binding, role: "supervisor", kind: "hello", id: "hello", ready: true, reply: true });
		await new Promise(resolve => setImmediate(resolve));
		expect(views().filter(view => !previousIds.has(view.id))).toHaveLength(1);
		expect(views().at(-1)!.id).not.toBe(original.id);
		expect(views().at(-1)!.text).toContain("The worker stopped.");
		expect(views().at(-1)!.text).toContain("current result must exist");
		await flow.commands.get("goals").handler("clear", flow.ctx);
		const afterClear = views().length;
		flow.transport.receive({ binding: original.binding, role: "supervisor", kind: "hello", id: "hello", ready: true });
		await new Promise(resolve => setImmediate(resolve));
		expect(views()).toHaveLength(afterClear);
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("reconnects an approved worker with work without making a new pairing", async () => {
	const flow = setup(["Ready"]);
	try {
		await flow.commands.get("goals").handler("draft", flow.ctx);
		approvedPlan(flow.cwd);
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		const state = flow.entries.at(-1)?.data as any;
		await flow.commands.get("goals").handler("work", flow.ctx);
		expect(flow.entries.at(-1)?.data).toMatchObject({ approvalId: state.approvalId, phase: "working" });
		expect(openSupervisorPane).toHaveBeenCalledTimes(1);
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it.each(["launch", "model"])("rejects plan content changes during Ready %s without replacing its pane", async (stage) => {
	const flow = setup(["Ready", "Ready"]);
	try {
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		const path = approvedPlan(flow.cwd);
		const mutate = () => writeFileSync(path, readFileSync(path, "utf8").replace("make the file", "make a different report"));
		if (stage === "launch") openSupervisorPane.mockImplementationOnce(async () => { mutate(); return "pane-2"; });
		else flow.pi.setModel.mockImplementationOnce(async () => { mutate(); return true; });
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", supervisorPaneId: stage === "launch" ? "pane-2" : null });
		expect(flow.messages.some(message => message.content.includes("Begin implementation"))).toBe(false);
		expect(flow.notifications.join("\n")).toContain("plan changed after Ready");
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		expect(openSupervisorPane).toHaveBeenCalledTimes(1);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working" });
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("compacts the approved worker before forking the supervisor without injecting planning context", async () => {
	const flow = setup(["Ready"]);
	try {
		let complete: (() => void) | undefined;
		flow.ctx.compact.mockImplementationOnce((options: any) => { complete = options.onComplete; });
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		approvedPlan(flow.cwd);
		const ready = flow.hooks.get("agent_settled")({}, flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		expect(flow.ctx.compact).toHaveBeenCalledOnce();
		expect(flow.ctx.compact.mock.calls[0][0].customInstructions).toContain("was just approved");
		expect(openSupervisorPane).not.toHaveBeenCalled();
		await flow.hooks.get("session_compact")({}, flow.ctx);
		const context = await flow.hooks.get("context")({ messages: [] }, flow.ctx);
		expect(context?.messages).toBeUndefined();
		complete!();
		await ready;
		expect(flow.pi.setModel).toHaveBeenCalledBefore(openSupervisorPane);
		expect(openSupervisorPane).toHaveBeenCalledOnce();
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working" });
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("falls back loudly after explicit Ready launch failure, preserving its failed pane and approved content", async () => {
	const flow = setup(["Ready"]);
	try {
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		const path = approvedPlan(flow.cwd);
		const before = readFileSync(path, "utf8");
		openSupervisorPane.mockImplementationOnce(async (_input: any, opened: any) => { opened("failed-pane"); throw new Error("pane run failed"); });
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", mode: "solo", supervisorPaneId: "failed-pane", approvalId: null });
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(flow.notifications.at(-1)).toContain("pane run failed");
		expect(flow.notifications.at(-1)).toContain("UNSUPERVISED WORKER");
		expect(flow.notifications.at(-1)).toContain("same approved plan");
		expect(flow.notifications.at(-1)).toContain("Supervisor sign-off is unavailable");
		expect(flow.notifications.at(-1)).toContain("/goals restart");
		expect(flow.messages.at(-1)?.content).toContain("Continue useful implementation");
		expect(closeSupervisorPane).not.toHaveBeenCalled();
		expect(await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "result.txt" } }, flow.ctx)).toBeUndefined();
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
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", planVersion: 1, approvalId: null });
		expect(openSupervisorPane).not.toHaveBeenCalled();
		expect(wire.worker.sent.filter(message => message.kind === "hello" && message.ready)).toHaveLength(0);
		expect(supervisor.connected).toBe(false);
		expect(() => supervisor.steer("Must wait.")).toThrow("pairing is not active");
		await flow.hooks.get("model_select")({ source: "set", model: { provider: "test", id: "chosen" } }, flow.ctx);
		flow.ctx.modelRegistry.find = (provider, id) => ({ provider, id });
		await flow.commands.get("goals").handler("reconnect", flow.ctx);
		expect(supervisor.connected).toBe(false); // Planning is not implementation readiness.
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		expect(supervisor.connected).toBe(true);
		const binding = (flow.entries.at(-1)?.data as any).approvalId;
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


it("explicit solo persists across reload/compaction, rejects sign-off and restores supervision only through restart", async () => {
	const flow = setup([]);
	try {
		const path = restoredPlan(flow);
		const before = readFileSync(path, "utf8");
		await flow.hooks.get("session_start")({}, flow.ctx);
		const pendingSignoff = flow.tools.get("CompleteGoal").execute("pending", { goal: "make the file" }, undefined, undefined, flow.ctx);
		await flow.commands.get("goals").handler("solo", flow.ctx);
		expect((await pendingSignoff).isError).toBe(true);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", mode: "solo", approvalId: null, planVersion: 1 });
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("UNSUPERVISED"));
		expect(closeSupervisorPane).not.toHaveBeenCalled();
		const signoff = await flow.tools.get("CompleteGoal").execute("solo", { goal: "make the file" }, undefined, undefined, flow.ctx);
		expect(signoff.isError).toBe(true);
		expect(signoff.content[0].text).toContain("unavailable in solo mode");
		const count = flow.transport.sent.length;
		await flow.hooks.get("session_start")({}, flow.ctx);
		await flow.hooks.get("session_compact")({}, flow.ctx);
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		expect(flow.transport.sent).toHaveLength(count);
		expect((await flow.hooks.get("before_agent_start")({}, flow.ctx)).systemPrompt).toContain("UNSUPERVISED implementation worker");
		expect((await flow.hooks.get("context")({ messages: [] }, flow.ctx)).messages[0].content[0].text).toContain("You are UNSUPERVISED");
		await flow.commands.get("goals").handler("reconnect", flow.ctx);
		expect(openSupervisorPane).not.toHaveBeenCalled();
		expect(flow.notifications.at(-1)).toContain("remaining UNSUPERVISED");
		await flow.commands.get("goals").handler("restart", flow.ctx);
		expect(closeSupervisorPane).toHaveBeenCalledExactlyOnceWith("owned-pane");
		expect(openSupervisorPane).toHaveBeenCalledTimes(1);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", mode: "supervised", soloReason: null, planVersion: 1 });
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("supervised worker"));
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it.each(["startup", "resume", "disconnect"])("allows the existing five-minute recovery window before loud %s timeout fallback", async stage => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	const flow = setup(["Ready"]);
	try {
		let waiting: Promise<void> | undefined;
		if (stage === "startup") {
			await flow.commands.get("goals").handler("make the file", flow.ctx);
			approvedPlan(flow.cwd);
			flow.transport.replyToHello(false);
			waiting = flow.hooks.get("agent_settled")({}, flow.ctx);
		} else {
			restoredPlan(flow);
			if (stage === "resume") flow.transport.replyToHello(false);
			await flow.hooks.get("session_start")({}, flow.ctx);
			if (stage === "disconnect") {
				flow.transport.replyToHello(false);
				flow.transport.event({ type: "session_left", sessionId: "peer" });
			}
		}
		await vi.advanceTimersByTimeAsync(299_999);
		expect(flow.notifications.some(text => text.includes("UNSUPERVISED WORKER"))).toBe(false);
		expect((await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "result.txt" } }, flow.ctx)).block).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", mode: "solo", approvalId: null });
		expect(flow.notifications.at(-1)).toContain("Supervisor did not become ready through pi-intercom");
		expect(await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "result.txt" } }, flow.ctx)).toBeUndefined();
		const count = flow.messages.length;
		flow.transport.receive({ binding: "restored-binding", role: "supervisor", kind: "hello", id: "hello", ready: true });
		await vi.advanceTimersByTimeAsync(300_000);
		expect(flow.messages).toHaveLength(count); // A late old peer never silently restores supervision.
		expect(flow.entries.at(-1)?.data).toMatchObject({ mode: "solo" });
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("falls back with the exact reported terminal peer failure without confusing it with worker model failure", async () => {
	const flow = setup([]);
	try {
		restoredPlan(flow);
		await flow.hooks.get("session_start")({}, flow.ctx);
		flow.transport.replyToHello(false);
		flow.transport.receive({ binding: "restored-binding", role: "supervisor", kind: "hello", id: "hello", ready: false });
		flow.transport.receive({ binding: "restored-binding", role: "supervisor", kind: "hello", id: "hello", ready: false, failure: "Supervisor model failed: quota exceeded (429)" });
		await new Promise(resolve => setImmediate(resolve));
		expect(flow.entries.at(-1)?.data).toMatchObject({ mode: "solo" });
		expect(flow.notifications.at(-1)).toContain("quota exceeded (429)");
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it.each(["solo", "peer failure"])("does not bypass an unavailable worker model on %s", async action => {
	const flow = setup([]);
	try {
		restoredPlan(flow);
		flow.pi.setModel.mockResolvedValue(false);
		await flow.hooks.get("session_start")({}, flow.ctx);
		if (action === "solo") await flow.commands.get("goals").handler("solo", flow.ctx);
		else flow.transport.receive({ binding: "restored-binding", role: "supervisor", kind: "hello", id: "hello", ready: false, failure: "Supervisor unavailable" });
		await new Promise(resolve => setImmediate(resolve));
		expect(flow.notifications.some(text => text.includes("UNSUPERVISED WORKER"))).toBe(false);
		expect((await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "result.txt" } }, flow.ctx)).block).toBe(true);
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it.each(["changed", "noplan", "worker model", "repository"])("never uses initial supervisor failure to approve a %s Ready attempt", async cause => {
	const flow = setup(["Ready"]);
	try {
		await flow.commands.get("goals").handler("make the file", flow.ctx);
		const path = approvedPlan(flow.cwd);
		if (cause === "worker model") flow.pi.setModel.mockResolvedValue(false);
		if (cause === "repository") rmSync(join(flow.cwd, ".git"), { recursive: true, force: true });
		openSupervisorPane.mockImplementationOnce(async () => {
			if (cause === "changed") writeFileSync(path, readFileSync(path, "utf8").replace("make the file", "spend money"));
			if (cause === "noplan") await flow.commands.get("goals").handler("noplan", flow.ctx);
			throw new Error("Supervisor launch failed");
		});
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		expect(flow.notifications.some(text => text.includes("UNSUPERVISED WORKER"))).toBe(false);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: cause === "noplan" ? null : "planning" });
		await flow.commands.get("goals").handler("solo", flow.ctx);
		expect(flow.notifications.at(-1)).toContain("already-approved plan");
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("stays loudly solo when replacement fails and never restores a cleared plan after a pending recovery", async () => {
	const flow = setup([]);
	try {
		restoredPlan(flow);
		await flow.hooks.get("session_start")({}, flow.ctx);
		await flow.commands.get("goals").handler("solo", flow.ctx);
		openSupervisorPane.mockRejectedValueOnce(new Error("Herdr launch refused"));
		await flow.commands.get("goals").handler("restart", flow.ctx);
		expect(flow.entries.at(-1)?.data).toMatchObject({ mode: "solo" });
		expect(flow.notifications.at(-1)).toContain("Herdr launch refused");
		let finish: (() => void) | undefined;
		openSupervisorPane.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve("late-pane"); }));
		const restarting = flow.commands.get("goals").handler("restart", flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		await flow.commands.get("goals").handler("clear", flow.ctx);
		finish!();
		await restarting;
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, planVersion: null });
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it.each([
	["planning", "planning" as const, "Keep drafting"],
	["supervised work", "working" as const, "Keep working"],
	["solo work", "working" as const, "Keep working unsupervised"],
])("keeps an active %s plan when bare or free-text /goals is submitted", async (_name, phase, keepAction) => {
	const flow = setup([keepAction]);
	try {
		const path = restoredPlan(flow, phase);
		await flow.hooks.get("session_start")({}, flow.ctx);
		if (keepAction === "Keep working unsupervised") await flow.commands.get("goals").handler("solo", flow.ctx);
		const before = readFileSync(path, "utf8");
		const stateBefore = flow.entries.at(-1)?.data;
		await flow.commands.get("goals").handler("", flow.ctx);
		await flow.commands.get("goals").handler("describe a different project", flow.ctx);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(flow.entries.at(-1)?.data).toMatchObject(stateBefore as object);
		expect(closeSupervisorPane).not.toHaveBeenCalled();
		expect(flow.notifications.at(-1)).toContain("active plan is unchanged");
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("keeps the first-plan objective shortcut but requires plan to deliberately replace an active draft", async () => {
	const flow = setup([]);
	try {
		await flow.commands.get("goals").handler("first objective", flow.ctx);
		const firstPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
		expect(readFileSync(firstPath, "utf8")).toBe("");
		expect(flow.messages.at(-1)?.content).toContain("Objective: first objective");
		await flow.commands.get("goals").handler("plan restart", flow.ctx);
		expect(readFileSync(firstPath, "utf8")).toBe("");
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", planVersion: 2, latestDirection: "restart" });
		expect(flow.messages.at(-1)?.content).toContain("Objective: restart");
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("offers per-verb autocomplete descriptions without treating an objective as a verb", () => {
	const flow = setup([]);
	try {
		const complete = flow.commands.get("goals").getArgumentCompletions;
		expect(complete("plan")).toEqual([{ value: "plan", label: "plan", description: expect.stringContaining("Deliberately") }]);
		expect(complete("solo")).toEqual([{ value: "solo", label: "solo", description: expect.stringContaining("sign-off unavailable") }]);
		expect(complete("re").map((item: any) => item.value)).toEqual(["reconnect", "restart"]);
		expect(complete("write a report")).toBeNull();
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});


it("keeps worker runtime errors paused after Pi retries, rather than treating them as supervisor failures", async () => {
	const flow = setup([]);
	try {
		restoredPlan(flow);
		await flow.hooks.get("session_start")({}, flow.ctx);
		await flow.hooks.get("agent_end")({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "worker quota exceeded" }] }, flow.ctx);
		await flow.hooks.get("agent_settled")({}, flow.ctx);
		flow.transport.receive({ binding: "restored-binding", role: "supervisor", kind: "hello", id: "hello", ready: false, failure: "supervisor unavailable too" });
		await flow.commands.get("goals").handler("solo", flow.ctx);
		expect(flow.notifications.at(-1)).toContain("worker quota exceeded");
		expect(flow.notifications.some(text => text.includes("UNSUPERVISED WORKER"))).toBe(false);
		expect((await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "result.txt" } }, flow.ctx)).block).toBe(true);
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("keeps a healthy pairing ready when restart cannot close its pane", async () => {
	const flow = setup([]);
	try {
		const path = restoredPlan(flow);
		const before = readFileSync(path, "utf8");
		await flow.hooks.get("session_start")({}, flow.ctx);
		closeSupervisorPane.mockRejectedValueOnce(new Error("Herdr close unavailable"));
		await flow.commands.get("goals").handler("restart", flow.ctx);
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", mode: "supervised", approvalId: "restored-binding", supervisorPaneId: "owned-pane" });
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(openSupervisorPane).not.toHaveBeenCalled();
		expect(flow.notifications.at(-1)).toContain("Could not close the tracked supervisor pane");
		expect(flow.notifications.some(text => text.includes("UNSUPERVISED WORKER"))).toBe(false);
		expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("supervised worker"));
		expect(await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "result.txt" } }, flow.ctx)).toBeUndefined();
		flow.transport.receive({ binding: "restored-binding", role: "supervisor", kind: "steer", id: "still-paired", text: "Inspect the output." });
		expect(flow.messages.at(-1)?.content).toBe("[supervisor] Inspect the output.");
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it("labels solo completion claims unreviewed without implying a supervisor will review them", async () => {
	const flow = setup([]);
	try {
		const path = restoredPlan(flow);
		await flow.hooks.get("session_start")({}, flow.ctx);
		writeFileSync(path, readFileSync(path, "utf8").replace("[ ] goal:", "[x] goal:"));
		await flow.commands.get("goals").handler("solo", flow.ctx);
		expect(flow.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-goals-widget", [expect.stringContaining("UNSUPERVISED"), "? claimed complete; unreviewed (solo): make the file"]);
		expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("0/1 goals · UNSUPERVISED"));
		expect(flow.entries.at(-1)?.data).toMatchObject({ signedOffGoals: [] });
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it.each(["supervise", "noplan", "model", "busy reconnect", "solo", "work"])("does not let no-op %s cancel an in-flight restart", async noop => {
	const flow = setup([]);
	try {
		restoredPlan(flow);
		await flow.hooks.get("session_start")({}, flow.ctx);
		if (["solo", "work"].includes(noop)) await flow.commands.get("goals").handler("solo", flow.ctx);
		flow.transport.replyToHello(false);
		const restarting = flow.commands.get("goals").handler("restart", flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		const binding = (flow.entries.at(-1)?.data as any).approvalId;
		expect(binding).toBeTruthy();
		expect(binding).not.toBe("restored-binding");
		if (noop === "busy reconnect") flow.ctx.isIdle.mockReturnValue(false);
		await flow.commands.get("goals").handler(noop === "busy reconnect" ? "reconnect" : noop, flow.ctx);
		flow.ctx.isIdle.mockReturnValue(true);
		flow.transport.receive({ binding, role: "supervisor", kind: "hello", id: "hello", ready: true, reply: true });
		await restarting;
		expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", mode: "supervised", approvalId: binding });
		expect(flow.notifications.at(-1)).toBe("Goal supervision reconnected; the current plan is unchanged.");
		expect(flow.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-goals", expect.stringContaining("supervised worker"));
		expect(await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "result.txt" } }, flow.ctx)).toBeUndefined();
	} finally { rmSync(flow.cwd, { recursive: true, force: true }); }
});

it.each(["explicit solo", "terminal failure"])("announces %s to the old supervisor without a reciprocal failure loop", async cause => {
	const wire = pairedIntercomFixture();
	const flow = setup([], [], wire.worker.events as ExtensionAPI["events"]);
	const supervisor = new GoalIntercom({ events: wire.supervisor.events, on: () => {}, appendEntry: () => {} } as unknown as ExtensionAPI);
	const supervisorCtx = { sessionManager: { getEntries: () => [] }, ui: { notify: vi.fn() } };
	try {
		restoredPlan(flow);
		supervisor.configure("restored-binding", "supervisor", supervisorCtx as any, true);
		await flow.hooks.get("session_start")({}, flow.ctx);
		await new Promise(resolve => setImmediate(resolve));
		expect(supervisor.connected).toBe(true);
		if (cause === "explicit solo") await flow.commands.get("goals").handler("solo", flow.ctx);
		else supervisor.failReady("Supervisor quota exceeded");
		await new Promise(resolve => setImmediate(resolve));
		expect(supervisor.connected).toBe(false);
		expect(supervisorCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Worker entered solo mode; this pairing is detached"), "error");
		expect(() => supervisor.steer("Obsolete advice.")).toThrow(cause === "explicit solo" ? "pairing is detached" : "Supervisor quota exceeded");
		expect(flow.entries.at(-1)?.data).toMatchObject({ mode: "solo", approvalId: null });
		expect(flow.messages.filter(message => message.display && message.content.startsWith("UNSUPERVISED WORKER"))).toHaveLength(1);
		expect(wire.worker.sent.filter(message => message.failure?.startsWith("Worker entered solo"))).toHaveLength(1);
		expect(wire.supervisor.sent.some(message => message.failure?.startsWith("Worker entered solo"))).toBe(false);
		const count = wire.worker.sent.length + wire.supervisor.sent.length;
		await new Promise(resolve => setImmediate(resolve));
		expect(wire.worker.sent.length + wire.supervisor.sent.length).toBe(count);
	} finally { supervisor.detach(); rmSync(flow.cwd, { recursive: true, force: true }); }
});
