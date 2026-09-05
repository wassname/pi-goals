import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { approvalPath, goalBlock, hashGoalBlock, repositoryState, writeApproval } from "../src/approval.js";
import piGoalsExtension, { isSupervisorProcess } from "../src/index.js";

function setup(
	selectChoices: Array<string | undefined>,
	editorChoices: Array<string | undefined> = [],
	editPlan?: () => Promise<string | undefined>,
	contextTokens = 0,
	completeWorkerBeforeReply = false,
	compactError?: Error,
) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-flow-"));
	writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", ".gitignore"], { cwd });
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
	const commands = new Map<string, any>();
	const hooks = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const eventLog: string[] = [];
	const messages: Array<{ content: string; display?: boolean }> = [];
	const rpcRequests: any[] = [];
	const compactCalls: any[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
	const eventBus = {
		on(name: string, handler: (data: unknown) => void) {
			const handlers = eventHandlers.get(name) ?? new Set();
			handlers.add(handler);
			eventHandlers.set(name, handlers);
			return () => handlers.delete(handler);
		},
		emit(name: string, data: unknown) {
			for (const handler of [...(eventHandlers.get(name) ?? [])]) handler(data);
		},
	};
	let asyncRun = 0;
	eventBus.on("pi-subagents:runtime-agent-register:v1", (raw) => {
		(raw as any).result = { ok: true, registration: { dispose() {} } };
	});
	eventBus.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as any;
		rpcRequests.push(request);
		if (request.method === "status") {
			eventBus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				success: true,
				data: {
					text: "status",
					asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 0, children: 0, byteLimitExceeded: false }, runs: [] },
				},
			});
			return;
		}
		asyncRun++;
		if (completeWorkerBeforeReply) eventBus.emit("subagent:async-complete", { runId: `worker-${asyncRun}`, results: [{ success: true }] });
		eventBus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { text: "started", details: { asyncId: `worker-${asyncRun}` } } });
	});
	eventBus.on("processes:request:list", (raw) => {
		(raw as { reply(value: object[]): void }).reply([]);
	});
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: contextTokens }),
		compact: (options: any) => {
			compactCalls.push(options);
			if (compactError) options.onError?.(compactError);
			else options.onComplete?.({ summary: "summary" });
		},
		getSystemPrompt: () => "base prompt",
		sessionManager: { getSessionId: () => "session-a", getEntries: () => entries },
		ui: {
			theme: { fg: (_kind: string, text: string) => text },
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
			notify: (text: string) => notifications.push(text),
			select: async () => {
				eventLog.push("select");
				return selectChoices.shift();
			},
			editor: async () => {
				eventLog.push("editor");
				return editPlan ? editPlan() : editorChoices.shift();
			},
		},
	};
	const pi = {
		events: eventBus,
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => hooks.set(name, handler),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendMessage: (message: { content: string; display?: boolean }) => {
			eventLog.push("display");
			messages.push(message);
		},
		sendUserMessage: (message: string) => messages.push({ content: message }),
	};
	piGoalsExtension(pi as unknown as ExtensionAPI);
	return { commands, compactCalls, ctx, cwd, entries, events: eventLog, eventBus, hooks, messages, notifications, rpcRequests, statuses, tools, widgets };
}

function writeSupervisorApproval(flow: ReturnType<typeof setup>, goal: string): void {
	const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
	const plan = readFileSync(planPath, "utf8");
	const block = goalBlock(plan, goal);
	if (!block) throw new Error("test plan has no open goal");
	const state = flow.entries.at(-1)?.data as { approvalId: string; workerRunId: string };
	const repository = repositoryState(flow.cwd);
	writeApproval(approvalPath(flow.cwd, "session-a", goal), {
		version: 2,
		verdict: "accept",
		approvalId: state.approvalId,
		goal,
		planPath,
		goalBlockHash: hashGoalBlock(block),
		repoRoot: repository.repoRoot,
		head: repository.head,
		tree: repository.tree,
		cleanWorktree: true,
		inspected: { plan: true, repository: true, evidence: true, verifyOutput: true },
		supervisor: { sessionId: "supervisor-session", runId: state.workerRunId },
		timestamp: "2026-09-05T00:00:00.000Z",
	});
}

describe("/goals draft flow", () => {
	it("preserves prior drafts, displays the plan before Refine, and records editor notes", async () => {
		const flow = setup(["Refine"], ["Keep two columns.\nDo not add a filter."]);
		try {
			const legacy = join(flow.cwd, ".pi/plan/session-a.md");
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(legacy, "old plan");
			await flow.commands.get("goals").handler("first objective", flow.ctx);
			const v1 = join(flow.cwd, ".pi/plan/session-a-v1.md");
			expect(readFileSync(v1, "utf-8")).toBe("");
			expect(readFileSync(legacy, "utf-8")).toBe("old plan");
			const plan = "# First plan\n\n## Goals\n\n1. [ ] goal: preserve this\n\n## Appendix (context, not approved)\nold context\n";
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(v1, plan);
			await flow.hooks.get("input")({ text: "The result must preserve column order.", source: "interactive" }, flow.ctx);

			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(flow.events).toEqual(["display", "select", "editor"]);
			expect(flow.messages.at(-1)?.content).toContain("Revise the plan at");
			expect(flow.messages.find((message) => message.display)?.content).toContain("goal: preserve this");
			const interviewedPlan = readFileSync(v1, "utf-8");
			expect(interviewedPlan).toContain("> The result must preserve column order.");
			expect(interviewedPlan).toMatch(/## Interview\n\n### .+\n\n> The result must preserve column order\.[\s\S]+> Keep two columns\.\n> Do not add a filter\./);
			const refineSnapshot = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(refineSnapshot.message.content).toContain("[PLANNING MODE]");
			const blocked = await flow.hooks.get("tool_call")({ toolName: "edit", input: { path: "README.md" } }, flow.ctx);
			expect(blocked?.block).toBe(true);

			await flow.commands.get("goals").handler("second objective", flow.ctx);
			expect(readFileSync(v1, "utf-8")).toBe(interviewedPlan);
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v2.md"), "utf-8")).toBe("");
			expect(flow.messages.at(-1)?.content).toContain("session-a-v2.md");

			await flow.commands.get("goals").handler("judge the vendor options", flow.ctx);
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v3.md"), "utf-8")).toBe("");
			expect(flow.messages.at(-1)?.content).toContain("Objective: judge the vendor options");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("disconnects without deleting the active plan", async () => {
		const flow = setup([]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: preserve this\n");

			await flow.commands.get("goals").handler("clear", flow.ctx);

			expect(readFileSync(planPath, "utf-8")).toContain("goal: preserve this");
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, planVersion: null });

			await flow.commands.get("goals").handler("next objective", flow.ctx);
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v2.md"), "utf-8")).toBe("");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("keeps supervisor and implementation-worker models separate", async () => {
		const flow = setup([]);
		try {
			await flow.commands.get("goals").handler("model provider/supervisor", flow.ctx);
			await flow.commands.get("goals").handler("worker-model provider/worker", flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ supervisorModel: "provider/supervisor", workerModel: "provider/worker" });
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("stops the retained supervisor before clearing an active plan", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			writeFileSync(join(flow.cwd, ".pi/plan/session-a-v1.md"), "# Plan\n\n## Goals\n\n1. [/] goal: work\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);

			await flow.commands.get("goals").handler("clear", flow.ctx);

			expect(flow.rpcRequests.at(-1)).toMatchObject({ method: "stop", params: { id: "worker-1" } });
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: null, workerRunId: null, workerPending: false });
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("waits for Refine notes before starting a revision turn", async () => {
		let submitNotes: (notes: string) => void;
		const flow = setup(["Refine"], [], () => new Promise((resolve) => {
			submitNotes = resolve;
		}));
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: make this specific\n");

			const review = flow.hooks.get("agent_settled")({}, flow.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			expect(flow.events).toEqual(["display", "select", "editor"]);
			expect(flow.messages.filter((message) => !message.display)).toHaveLength(1);

			submitNotes!("Name the output artifact.");
			await review;
			expect(flow.messages.at(-1)?.content).toContain("Revise the plan at");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("starts work only when the human chooses Ready", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: work on this\n");

			await flow.hooks.get("agent_settled")({}, flow.ctx);

			expect(flow.events).toEqual(["display", "select"]);
			expect(flow.rpcRequests[0]).toMatchObject({ method: "spawn", params: { agent: "goal-supervisor", context: "fresh" } });
			expect(flow.messages.filter((message) => !message.display)).toHaveLength(1);
			const supervisor = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(supervisor.systemPrompt).toContain("thin human-facing coordinator");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("edits a plan in Pi and cancels without starting work", async () => {
		const original = "# Plan\n\n## Goals\n\n1. [ ] goal: original\n";
		const edited = "# Plan\n\n## Goals\n\n1. [ ] goal: edited\n";
		const flow = setup(["Edit", "Cancel"], [edited]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, original);

			await flow.hooks.get("agent_settled")({}, flow.ctx);

			expect(flow.events).toEqual(["display", "select", "editor", "display", "select"]);
			expect(() => readFileSync(planPath, "utf-8")).toThrow();
			expect(flow.messages.filter((message) => !message.display)).toHaveLength(1);
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("resyncs the whole plan once without telling the supervisor to implement it", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n\n## Log\n- worker evidence\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);

			const resync = await flow.hooks.get("context")({ messages: [] }, flow.ctx);
			expect(resync.messages.at(-1).content[0].text).toContain("worker evidence");
			expect(resync.messages.at(-1).content[0].text).not.toContain("Keep it current as you work");
			expect(await flow.hooks.get("context")({ messages: [] }, flow.ctx)).toBeUndefined();
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("checks every interval without pausing after unchanged work", async () => {
		vi.useFakeTimers();
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.commands.get("goals").handler("auto 1", flow.ctx);

			await vi.advanceTimersByTimeAsync(30_000);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(flow.rpcRequests).toHaveLength(2);
			expect(flow.rpcRequests.at(-1)).toMatchObject({ method: "steer", params: { id: "worker-1", message: expect.stringContaining("supervisor check is due") } });

			for (let n = 3; n <= 4; n++) {
				await vi.advanceTimersByTimeAsync(60_000);
				expect(flow.rpcRequests).toHaveLength(n);
				await flow.hooks.get("agent_settled")({}, flow.ctx);
			}
		} finally {
			vi.useRealTimers();
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("starts the supervisor before Ready (compact), while Ready preserves main context", async () => {
		const ready = setup(["Ready"]);
		const compacted = setup(["Ready (compact)"]);
		try {
			for (const flow of [ready, compacted]) {
				await flow.commands.get("goals").handler("objective", flow.ctx);
				writeFileSync(join(flow.cwd, ".pi/plan/session-a-v1.md"), "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n");
				await flow.hooks.get("agent_settled")({}, flow.ctx);
			}

			expect(ready.compactCalls).toHaveLength(0);
			expect(ready.rpcRequests).toHaveLength(1);
			expect(compacted.compactCalls).toHaveLength(1);
			expect(compacted.rpcRequests).toHaveLength(1);
			const resync = await compacted.hooks.get("context")({ messages: [] }, compacted.ctx);
			expect(resync.messages.at(-1).content[0].text).toContain("The main coordinator was compacted after the retained supervisor started.");
		} finally {
			rmSync(ready.cwd, { recursive: true, force: true });
			rmSync(compacted.cwd, { recursive: true, force: true });
		}
	});

	it("keeps the already-started supervisor when requested main compaction fails", async () => {
		const flow = setup(["Ready (compact)"], [], undefined, 0, false, new Error("compactor unavailable"));
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			writeFileSync(join(flow.cwd, ".pi/plan/session-a-v1.md"), "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);

			expect(flow.compactCalls).toHaveLength(1);
			expect(flow.rpcRequests).toHaveLength(1);
			expect(flow.notifications).toContain("Main-session compaction failed; the retained supervisor continues: compactor unavailable");
			const working = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(working.systemPrompt).toContain("thin human-facing coordinator");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("checks exact subagent and process status after native worker completion", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			flow.eventBus.emit("subagent:async-complete", { runId: "worker-1", results: [{ success: true }] });

			const status = await flow.tools.get("CheckGoalWork").execute("", {}, undefined, undefined, flow.ctx);
			expect(status.isError).toBe(false);
			expect(status.content[0].text).toBe("subagents=idle; processes=idle");
			expect(flow.messages.some((message) => message.content.includes("worker stopped"))).toBe(false);
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("does not checkpoint after every goal is closed", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: produce report\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			flow.eventBus.emit("subagent:async-complete", { runId: "worker-1" });

			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [x] goal: produce report\n");
			await flow.hooks.get("turn_end")({}, flow.ctx);
			for (let turn = 0; turn < 8; turn++) await flow.hooks.get("turn_end")({}, flow.ctx);
			await flow.hooks.get("agent_settled")({}, flow.ctx);

			expect(flow.rpcRequests).toHaveLength(1);
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("records a worker that completes before its launch RPC reply as stopped", async () => {
		const flow = setup(["Ready"], [], undefined, 0, true);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: finish quickly\n");

			await flow.hooks.get("agent_settled")({}, flow.ctx);

			expect(flow.entries.at(-1)?.data).toMatchObject({ workerRunId: "worker-1", workerPending: false });
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("resumes the retained supervisor and lets the coordinator mechanically sign off", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: produce report\n  - discriminator: report.txt contains PASS\n  - evidence:\n    - report.txt: `PASS`\n\n## Log\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(flow.rpcRequests[0]).toMatchObject({ method: "spawn", params: { agent: "goal-supervisor", context: "fresh" } });
			flow.eventBus.emit("subagent:async-complete", { runId: "worker-1", results: [{ success: true }] });

			const resumed = await flow.tools.get("GuideGoalWorker").execute("", { instruction: "Verify report.txt." }, undefined, undefined, flow.ctx);
			expect(resumed.isError).toBe(false);
			expect(flow.rpcRequests[1]).toMatchObject({ method: "resume", params: { id: "worker-1", message: expect.stringContaining("Verify report.txt.") } });
			expect(flow.entries.at(-1)?.data).toMatchObject({ workerRunId: "worker-2", workerPending: true });

			flow.eventBus.emit("subagent:async-complete", { runId: "worker-2", results: [{ success: true }] });
			writeSupervisorApproval(flow, "produce report");
			const signoff = await flow.tools.get("CompleteGoal").execute("", { goal: "produce report" }, undefined, undefined, flow.ctx);
			expect(signoff.isError).toBe(false);
			expect(readFileSync(planPath, "utf-8")).toContain("1. [x] goal: produce report");
			expect(readFileSync(planPath, "utf-8")).toContain("mechanically signed off \"produce report\" after matching supervisor approval");

			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.tools.get("GuideGoalWorker").execute("", { instruction: "Report current status." }, undefined, undefined, flow.ctx);
			expect(flow.rpcRequests.at(-1)).toMatchObject({ method: "resume", params: { id: "worker-2", message: expect.stringContaining("Report current status.") } });
			expect(existsSync(approvalPath(flow.cwd, "session-a", "produce report"))).toBe(false);
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("blocks main implementation while allowing supervisor inspection, control, and sign-off", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n\n## Log\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);

			const edit = await flow.hooks.get("tool_call")({ toolName: "edit", input: { path: "README.md" } }, flow.ctx);
			const write = await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "README.md" } }, flow.ctx);
			const shellWrite = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "printf changed > README.md" } }, flow.ctx);
			const findDelete = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "find . -delete" } }, flow.ctx);
			const gitOutput = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "git diff --output=README.md" } }, flow.ctx);
			const gitBranch = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "git branch new-name" } }, flow.ctx);
			const sibling = await flow.hooks.get("tool_call")({ toolName: "subagent", input: { agent: "worker" } }, flow.ctx);
			const status = await flow.hooks.get("tool_call")({ toolName: "subagent", input: { action: "status", view: "fleet" } }, flow.ctx);
			const inspect = await flow.hooks.get("tool_call")({ toolName: "read", input: { path: "README.md" } }, flow.ctx);
			const verify = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "git status && npm test && npm run typecheck && npm run lint" } }, flow.ctx);
			const work = await flow.tools.get("CheckGoalWork").execute("", {}, undefined, undefined, flow.ctx);
			const guide = await flow.tools.get("GuideGoalWorker").execute("", { instruction: "Save the verification output." }, undefined, undefined, flow.ctx);
			flow.eventBus.emit("subagent:async-complete", { runId: "worker-1", results: [{ success: true }] });
			writeSupervisorApproval(flow, "make the output");
			const signoff = await flow.tools.get("CompleteGoal").execute("", { goal: "make the output" }, undefined, undefined, flow.ctx);

			expect(edit?.block).toBe(true);
			expect(write?.block).toBe(true);
			expect(shellWrite?.block).toBe(true);
			expect(findDelete?.block).toBe(true);
			expect(gitOutput?.block).toBe(true);
			expect(gitBranch?.block).toBe(true);
			expect(sibling?.block).toBe(true);
			expect(status).toBeUndefined();
			expect(inspect).toBeUndefined();
			expect(verify).toBeUndefined();
			expect(work.isError).toBe(false);
			expect(guide.isError).toBe(false);
			expect(signoff.isError).toBe(false);
			expect(readFileSync(planPath, "utf-8")).toContain("1. [x] goal: make the output");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("fails closed without a matching supervisor approval checkpoint", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n  - evidence: verify.log: PASS\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			flow.eventBus.emit("subagent:async-complete", { runId: "worker-1", results: [{ success: true }] });

			const missing = await flow.tools.get("CompleteGoal").execute("", { goal: "make the output" }, undefined, undefined, flow.ctx);
			expect(missing.isError).toBe(true);
			expect(missing.content[0].text).toContain("no matching supervisor approval checkpoint");

			writeSupervisorApproval(flow, "make the output");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n  - evidence: verify.log: PASS after rerun\n");
			const stale = await flow.tools.get("CompleteGoal").execute("", { goal: "make the output" }, undefined, undefined, flow.ctx);
			expect(stale.isError).toBe(true);
			expect(stale.content[0].text).toContain("no matching supervisor approval checkpoint");

			writeSupervisorApproval(flow, "make the output");
			writeFileSync(join(flow.cwd, "uncommitted.txt"), "dirty\n");
			const dirty = await flow.tools.get("CompleteGoal").execute("", { goal: "make the output" }, undefined, undefined, flow.ctx);
			expect(dirty.isError).toBe(true);
			expect(dirty.content[0].text).toContain("worktree is dirty");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("labels live goals supervising and all-done goals complete", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.hooks.get("turn_end")({}, flow.ctx);
			expect(flow.widgets.at(-1)).toEqual(["▸ supervising… make the output"]);
			expect(flow.statuses.at(-1)).toContain("supervising…");

			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [x] goal: make the output\n");
			await flow.hooks.get("turn_end")({}, flow.ctx);
			expect(flow.widgets.at(-1)).toEqual(["✔ complete"]);
			expect(flow.statuses.at(-1)).toContain("1/1 goals · complete");
			expect(flow.statuses.at(-1)).not.toContain("supervising…");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("does not install the supervisor gate in a worker child", () => {
		expect(isSupervisorProcess(false)).toBe(true);
		expect(isSupervisorProcess(true)).toBe(false);
	});

	it("gives the agent a planning snapshot and blocks work routes", async () => {
		const flow = setup([]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning" });
			await flow.hooks.get("session_start")({}, flow.ctx);
			const snapshot = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(snapshot.message.content).toContain("[PLANNING MODE]");
			expect(snapshot.message.content).toContain(planPath);

			const writePlan = await flow.hooks.get("tool_call")({ toolName: "write", input: { path: planPath } }, flow.ctx);
			const writeCode = await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "README.md" } }, flow.ctx);
			const readShell = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "pwd && ls && git log" } }, flow.ctx);
			const changeDirectoryThenRead = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "cd . && ls -la" } }, flow.ctx);
			const pipeShell = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "ls | head" } }, flow.ctx);
			const pythonWrite = await flow.hooks.get("tool_call")({ toolName: "bash", input: { command: "python -c \"open('README.md', 'w')\"" } }, flow.ctx);
			const signoff = await flow.tools.get("CompleteGoal").execute("", { goal: "work" }, undefined, undefined, flow.ctx);
			await flow.hooks.get("session_compact")({}, flow.ctx);
			const compacted = await flow.hooks.get("context")({ messages: [] }, flow.ctx);

			expect(writePlan).toBeUndefined();
			expect(writeCode?.block).toBe(true);
			expect(readShell).toBeUndefined();
			expect(changeDirectoryThenRead).toBeUndefined();
			expect(pipeShell?.block).toBe(true);
			expect(pythonWrite?.block).toBe(true);
			expect(signoff.isError).toBe(true);
			expect(compacted.messages.at(-1).content[0].text).toContain("[PLANNING MODE]");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});
});
