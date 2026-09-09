import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, type ExtensionAPI, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalPath } from "../src/approval.js";
import { approveGoalDescription, approveGoalParameters, goalApprovalRecorded, steerWorkerDescription, steerWorkerInstructionDescription, supervisorCompaction, supervisorOrientation, supervisorReviewContext } from "../src/prompts.js";
import { registerVisibleSupervisor } from "../src/supervisor-session.js";
import { intercomFixture } from "./intercom-fixture.js";

const shutdowns: Array<() => Promise<void>> = [];

function setup(cwd: string, planPath: string, tokens: number | null = 10, onCompact: (options: any) => void = (options) => options.onComplete()) {
	const transport = intercomFixture();
	vi.stubEnv("PI_GOALS_WORKER_ID", "worker-session");
	vi.stubEnv("PI_GOALS_OWNER_SESSION_ID", "worker-session");
	vi.stubEnv("PI_GOALS_PLAN_PATH", planPath);
	vi.stubEnv("PI_GOALS_APPROVAL_ID", "approval-1");
	const hooks = new Map<string, any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const messages: string[] = [];
	let branch: any[] = [];
	let activeTools = ["read", "grep", "bash", "write", "edit", "intercom", "custom_inspection", "custom_action"];
	const ctx = {
		cwd,
		isIdle: () => true,
		getSystemPrompt: () => "base",
		model: { provider: "test", id: "supervisor" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		getContextUsage: () => tokens === null ? undefined : ({ tokens }),
		compact: vi.fn(onCompact),
		sessionManager: { getEntries: () => entries, getBranch: () => [...entries, ...branch], getSessionId: () => "supervisor-session" },
		ui: { notify: vi.fn() },
	};
	const pi = {
		events: transport.events,
		on: (name: string, handler: any) => {
			const prior = hooks.get(name);
			hooks.set(name, async (...args: any[]) => { await prior?.(...args); return handler(...args); });
		},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (text: string) => { messages.push(text); void hooks.get("message_start")?.({ message: { role: "user", content: [{ type: "text", text }] } }); },
		getActiveTools: () => activeTools,
		setModel: vi.fn(async () => true),
		setActiveTools: (next: string[]) => { activeTools = next; },
	};
	registerVisibleSupervisor(pi as unknown as ExtensionAPI);
	shutdowns.push(() => hooks.get("session_shutdown")());
	return {
		commands, pi, activeTools: () => activeTools, branch: (value: any[]) => { branch = value; }, ctx, entries, hooks, transport, messages, tools,
		ready: () => transport.sent.some(message => message.kind === "hello" && message.role === "supervisor" && message.ready),
		start: async () => { await hooks.get("session_start")({}, ctx); await new Promise(resolve => setImmediate(resolve)); },
		view: (id: string, text: string, reason = "settled", backgroundQuiet = true) => {
			transport.receive({ binding: "approval-1", role: "worker", kind: "view", id, text, reason, backgroundQuiet });
			return { text };
		},
	};
}

afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("visible supervisor session", () => {
	it("restores monitoring without removing normal or custom tools or replaying persisted views", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-resume-"));
		try {
			const first = setup(cwd, join(cwd, "plan.md"));
			await first.start();
			const view = first.view("first", "The worker stopped.");
			expect(first.messages).toEqual([view.text]);
			await first.hooks.get("session_shutdown")();
			const resumed = setup(cwd, join(cwd, "plan.md"), 30_000);
			resumed.entries.push(...first.entries);
			await resumed.start();
			expect(resumed.activeTools()).toEqual(first.activeTools());
			expect(resumed.activeTools()).toEqual(["read", "grep", "bash", "write", "edit", "intercom", "custom_inspection", "custom_action"]);
			expect(resumed.ctx.compact).not.toHaveBeenCalled();
			resumed.view("first", view.text);
			expect(resumed.messages).toEqual([]);
			const latest = resumed.view("second", "The worker stopped.\nCurrent view.");
			expect(resumed.messages).toEqual([latest.text]);
			resumed.view("third", "The worker is still working.", "started");
			expect(resumed.messages).toEqual([latest.text]);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("renders all advice in real Pi tool rows, including collapsed and restored rows", () => {
		initTheme("dark");
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-render-"));
		try {
			const runtime = setup(cwd, join(cwd, "plan.md"));
			const tool = runtime.tools.get("SteerWorker");
			const lines = Array.from({ length: 18 }, (_, i) => `Advice ${i + 1}: inspect evidence.`);
			const instruction = lines.join("\n");
			for (const restored of [false, true]) {
				const row = new ToolExecutionComponent("SteerWorker", "call", restored ? { instruction } : {}, {}, tool, { requestRender() {} } as any, cwd);
				expect(stripVTControlCharacters(row.render(40).join("\n"))).not.toContain("undefined");
				row.updateArgs({ instruction });
				row.setArgsComplete();
				row.updateResult({ content: [{ type: "text", text: "Receipt unconfirmed." }], isError: false });
				for (const expanded of [false, true]) {
					row.setExpanded(expanded);
					for (const width of [40, 100]) {
						const output = stripVTControlCharacters(row.render(width).join("\n"));
						for (const line of lines) expect(output).toContain(line);
						expect(output).toContain("Receipt unconfirmed.");
					}
				}
			}
			const assistant = new AssistantMessageComponent(undefined, false);
			for (const streaming of [true, false]) {
				assistant.updateContent({ role: "assistant", content: [
					{ type: "thinking", thinking: "The signs disagree. Inspect the outputs." },
					{ type: "text", text: "Progress is mixed; the second check still fails." },
					{ type: "toolCall", id: "call", name: "SteerWorker", arguments: { instruction } },
				] } as any, streaming);
				const output = stripVTControlCharacters(assistant.render(100).join("\n"));
				expect(output).toContain("The signs disagree.");
				expect(output).toContain("Progress is mixed;");
			}
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("asks for judgment and useful recaps without inventing instructions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-prompt-"));
		try {
			writeFileSync(join(cwd, "plan.md"), "# Outcome\nBeat random\n1. [ ] goal: repair\n  - discriminator: beats random\n## Log\nold history");
			const runtime = setup(cwd, join(cwd, "plan.md"));
			const first = await runtime.hooks.get("before_agent_start")({}, runtime.ctx);
			const systemPrompt = `${first.systemPrompt}\n${first.message.content}`;
			expect(systemPrompt).toContain("brief visible recap");
			expect(systemPrompt).toContain("discriminator: beats random");
			expect(systemPrompt).not.toContain("old history");
			expect(first.message.customType).toBe("pi-goals-supervisor-role");
			const activePlan = "# Outcome\nBeat random\n1. [ ] goal: repair\n  - discriminator: beats random";
			expect(first.systemPrompt).toBe(`base\n\n${supervisorReviewContext(join(cwd, "plan.md"), activePlan)}`);
			expect(first.message.content).toBe(supervisorOrientation(join(cwd, "plan.md"), activePlan));
			const review = async () => runtime.hooks.get("before_agent_start")({}, runtime.ctx);
			const next = await review();
			expect(next.message).toBeUndefined();
			expect(next.systemPrompt).toContain("autonomously extending the user's agency");
			expect(next.systemPrompt).toContain("Inspect and diagnose directly. Delegate changes to the worker through SteerWorker; do not take over implementation or alter shared state.");
			expect(first.message.content).toContain("instruction, not an enforced sandbox");
			await runtime.hooks.get("session_compact")({}, runtime.ctx);
			expect((await review()).message.content).toContain("Protect the user's epistemic autonomy");
			writeFileSync(join(cwd, "plan.md"), "# Outcome\nBeat random\n1. [x] goal: repair\n  - discriminator: beats random\n");
			expect((await review()).systemPrompt).toContain("[x] goal: repair");
			expect(systemPrompt).toContain("your judgment");
			expect(systemPrompt).toContain("justified confidence, not certainty at any cost");
			expect(systemPrompt).toContain('Treat "blocked", "waiting", "impossible", and "already done" as claims to investigate');
			expect(systemPrompt).toContain("whether the claimed dependency is real");
			expect(systemPrompt).not.toMatch(/Modal|pueue|worktree/);
			expect(systemPrompt).toContain("what event will resume progress and how it will be observed");
			expect(systemPrompt).toContain("after checking what is already authorized");
			expect(systemPrompt).toContain("Check the actual deliverable against the user's goal");
			expect(systemPrompt).toContain("verbatim evidence with a source path or link");
			expect(systemPrompt).toContain("not independent evidence");
			expect(systemPrompt).toContain("checks that distinguish plausible explanations");
			expect(systemPrompt).toContain("Never repeat a steer that had no effect");
			expect(systemPrompt).toContain("Do not edit files or execute the worker's work");
			expect(systemPrompt).toContain("Keep independent work moving");
			expect(systemPrompt).toContain("do not invent work");
			expect(systemPrompt).toContain("give a short assessment and stop");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
	it("writes readiness without removing normal or custom extension tools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			const runtime = setup(cwd, join(cwd, ".pi/plan/worker-v1.md"));
			await runtime.hooks.get("session_start")({}, runtime.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			expect(runtime.ctx.compact).not.toHaveBeenCalled();
			expect(runtime.ready()).toBe(true);
			expect(runtime.activeTools()).toEqual(["read", "grep", "bash", "write", "edit", "intercom", "custom_inspection", "custom_action"]);
			expect(runtime.entries.at(-1)).toMatchObject({ customType: "pi-goals-visible-supervisor-v2" });
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("waits for an inherited 60-second compaction without starting a competing compaction", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-reload-"));
		try {
			const runtime = setup(cwd, join(cwd, "plan.md"), null);
			runtime.ctx.isIdle = () => false;
			await runtime.start();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(runtime.ctx.compact).not.toHaveBeenCalled();
			expect(runtime.ready()).toBe(false);
			runtime.entries.push({ type: "compaction", summary: "inherited compaction finished" });
			runtime.ctx.isIdle = () => true;
			await vi.advanceTimersByTimeAsync(1000);
			expect(runtime.ctx.compact).not.toHaveBeenCalled();
			expect(runtime.ready()).toBe(true);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("compacts a large planning fork before writing readiness", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			let complete: (() => void) | undefined;
			const runtime = setup(cwd, join(cwd, ".pi/plan/worker-v1.md"), 100_001, (options) => { complete = options.onComplete; });
			await runtime.hooks.get("session_start")({}, runtime.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			expect(runtime.ctx.compact).toHaveBeenCalledOnce();
			expect(runtime.ctx.compact.mock.calls[0][0].customInstructions).toBe(supervisorCompaction(join(cwd, ".pi/plan/worker-v1.md"), true));
			expect(runtime.ready()).toBe(false);
			complete!();
			expect(runtime.ready()).toBe(true);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("does not become ready when initial compaction fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			const runtime = setup(cwd, join(cwd, ".pi/plan/worker-v1.md"), null, (options) => options.onError(new Error("offline")));
			await runtime.hooks.get("session_start")({}, runtime.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			expect(runtime.ready()).toBe(false);
			expect(runtime.ctx.ui.notify).toHaveBeenCalledWith("Supervisor startup compaction failed: offline", "error");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("writes a durable worker instruction", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			const runtime = setup(cwd, join(cwd, "plan.md"));
			await runtime.start();
			expect(runtime.tools.get("SteerWorker").description).toBe(steerWorkerDescription);
			expect(runtime.tools.get("SteerWorker").parameters.properties.instruction.description).toBe(steerWorkerInstructionDescription);
			expect(runtime.tools.get("ApproveGoal").description).toBe(approveGoalDescription);
			expect(runtime.tools.get("ApproveGoal").parameters.properties.goal.description).toBe(approveGoalParameters.goal);
			const steered = await runtime.tools.get("SteerWorker").execute("id", { instruction: "Run the saved verification." });
			expect(steered.isError).toBe(false);
			expect(runtime.transport.sent.filter(message => message.kind === "steer")).toMatchObject([{ text: "Run the saved verification." }]);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("records approval only from a stopped view with evidence and no active work", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
		try {
			writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
			writeFileSync(join(cwd, "verify.txt"), "PASS\n");
			execFileSync("git", ["init", "-q"], { cwd });
			execFileSync("git", ["add", ".gitignore", "verify.txt"], { cwd });
			execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
			const planPath = join(cwd, ".pi/plan/worker-v1.md");
			execFileSync("mkdir", ["-p", join(cwd, ".pi/plan")]);
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: make the file\n  - discriminator: output exists\n  - evidence:\n    - `result.txt`: contains ok\n\n## Log\n");
			const runtime = setup(cwd, planPath);
			await runtime.start();
			const view = runtime.view("first", "The worker stopped.\n\ntool calls with no result: none");
			runtime.branch([{ type: "message", message: { role: "user", content: [{ type: "text", text: view.text }] } }]);
			const originalPlan = readFileSync(planPath, "utf8");
			for (const evidence of ["  - evidence: (empty until sign-off)", "  - evidence:\n    - (empty until sign-off)"]) {
				writeFileSync(planPath, originalPlan.replace("  - evidence:\n    - `result.txt`: contains ok", evidence));
				const rejected = await runtime.tools.get("ApproveGoal").execute("id", { goal: "make the file", verifyOutputPath: "verify.txt" }, undefined, undefined, runtime.ctx);
				expect(rejected.isError).toBe(true);
				expect(rejected.content[0].text).toContain("nonblank evidence");
				expect(existsSync(approvalPath(cwd, "worker-session", "make the file"))).toBe(false);
			}
			writeFileSync(planPath, originalPlan);
			const approved = await runtime.tools.get("ApproveGoal").execute("id", { goal: "make the file", verifyOutputPath: "verify.txt" }, undefined, undefined, runtime.ctx);
			expect(approved.isError).toBe(false);
			expect(approved.content[0].text).toBe(goalApprovalRecorded("make the file"));
			expect(existsSync(approvalPath(cwd, "worker-session", "make the file"))).toBe(true);
			runtime.view("second", "The worker is still working.", "started");
			const stale = await runtime.tools.get("ApproveGoal").execute("id", { goal: "make the file", verifyOutputPath: "verify.txt" }, undefined, undefined, runtime.ctx);
			expect(stale.isError).toBe(true);
			expect(stale.content[0].text).toContain("worker is starting or running");
			const unknown = runtime.view("third", "The worker stopped.\ntracked background work: unknown", "settled", false);
			runtime.branch([{ type: "message", message: { role: "user", content: [{ type: "text", text: unknown.text }] } }]);
			const blocked = await runtime.tools.get("ApproveGoal").execute("id", { goal: "make the file", verifyOutputPath: "verify.txt" }, undefined, undefined, runtime.ctx);
			expect(blocked.isError).toBe(true);
			expect(blocked.content[0].text).toContain("background work is active or unknown");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
});

it("does not enforce a supervisor tool-call denylist or reset extension tool selections", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "goals-supervisor-actuators-"));
	try {
		const runtime = setup(cwd, join(cwd, "plan.md"));
		await runtime.start();
		expect(runtime.activeTools()).toContain("intercom");
		const selection = ["intercom", "SteerWorker", "bash", "write", "edit", "custom_action"];
		runtime.pi.setActiveTools(selection);
		await runtime.commands.get("goals").handler("supervise", runtime.ctx);
		expect(runtime.activeTools()).toEqual(selection);
		const restorations = runtime.pi.setModel.mock.calls.length;
		await runtime.commands.get("goals").handler("work", runtime.ctx);
		expect(runtime.pi.setModel).toHaveBeenCalledTimes(restorations);
		expect(runtime.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("supervisor session"), "info");
		expect(runtime.hooks.has("tool_call")).toBe(false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("keeps a supervisor unready after model restoration failure, then recovers explicitly without substituting a model", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "goals-supervisor-model-recovery-"));
	try {
		const runtime = setup(cwd, join(cwd, "plan.md"));
		mkdirSync(join(cwd, ".pi/pi-goals/models"), { recursive: true });
		writeFileSync(join(cwd, ".pi/pi-goals/models/supervisor.json"), JSON.stringify({ provider: "gone", id: "expired" }));
		runtime.ctx.modelRegistry.find = vi.fn().mockReturnValue(undefined);
		await runtime.start();
		expect(runtime.ready()).toBe(false);
		expect(runtime.pi.setModel).not.toHaveBeenCalled();
		expect((await runtime.tools.get("SteerWorker").execute("id", { instruction: "Do not deliver." })).isError).toBe(true);
		runtime.ctx.modelRegistry.find = (provider, id) => ({ provider, id });
		await runtime.hooks.get("model_select")({ source: "set", model: { provider: "test", id: "chosen" } }, runtime.ctx);
		await runtime.commands.get("goals").handler("reconnect", runtime.ctx);
		await new Promise(resolve => setImmediate(resolve));
		expect(runtime.pi.setModel).toHaveBeenLastCalledWith({ provider: "test", id: "chosen" });
		expect(runtime.ready()).toBe(true);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("warns once on unavailable usage but stays quiet for Pi's post-compaction null token sample", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-usage-"));
	try {
		const runtime = setup(cwd, join(cwd, "plan.md"));
		await runtime.start();
		runtime.ctx.ui.notify.mockClear();
		runtime.ctx.getContextUsage = () => ({ tokens: null }) as any;
		await runtime.hooks.get("agent_settled")({}, runtime.ctx);
		expect(runtime.ctx.ui.notify).not.toHaveBeenCalled();
		runtime.ctx.getContextUsage = () => undefined;
		await runtime.hooks.get("agent_settled")({}, runtime.ctx);
		await runtime.hooks.get("agent_settled")({}, runtime.ctx);
		expect(runtime.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("custom 100k compaction trigger cannot be checked"), "warning");
		expect(runtime.ctx.compact).not.toHaveBeenCalled();
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
