import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piGoalsExtension from "../src/index.js";

function setup(
	selectChoices: Array<string | undefined>,
	editorChoices: Array<string | undefined> = [],
	editPlan?: () => Promise<string | undefined>,
) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-flow-"));
	const commands = new Map<string, any>();
	const hooks = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const events: string[] = [];
	const messages: Array<{ content: string; display?: boolean; customType?: string }> = [];
	const busHandlers = new Map<string, Set<(value: unknown) => unknown>>();
	const bus = {
		on(name: string, handler: (value: unknown) => unknown) {
			const handlers = busHandlers.get(name) ?? new Set();
			handlers.add(handler);
			busHandlers.set(name, handlers);
			return () => handlers.delete(handler);
		},
		emit(name: string, value: unknown) {
			for (const handler of busHandlers.get(name) ?? []) void handler(value);
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getSessionId: () => "session-a", getSessionFile: () => join(cwd, "session-a.jsonl"), getEntries: () => entries },
		ui: {
			theme: { fg: (_kind: string, text: string) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			select: async () => {
				events.push("select");
				return selectChoices.shift();
			},
			editor: async () => {
				events.push("editor");
				return editPlan ? editPlan() : editorChoices.shift();
			},
		},
	};
	const pi = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => hooks.set(name, handler),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		events: bus,
		sendMessage: (message: { content: string; display?: boolean; customType?: string }) => {
			events.push("display");
			messages.push(message);
		},
		sendUserMessage: (message: string) => messages.push({ content: message }),
	};
	piGoalsExtension(pi as unknown as ExtensionAPI);
	return { bus, commands, ctx, cwd, entries, events, hooks, messages, tools };
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

			await flow.commands.get("goals").handler("compare the vendor options", flow.ctx);
			expect(readFileSync(join(flow.cwd, ".pi/plan/session-a-v3.md"), "utf-8")).toBe("");
			expect(flow.messages.at(-1)?.content).toContain("Objective: compare the vendor options");

			await flow.commands.get("goals").handler("judge provider/model", flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ judgeModel: "provider/model", planVersion: 3 });
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
			expect(flow.messages.filter((message) => !message.display)).toHaveLength(2);
			expect(flow.messages.at(-1)?.content).toContain("Work the goals");
			await flow.hooks.get("session_start")({}, flow.ctx);
			expect(await flow.hooks.get("before_agent_start")({}, flow.ctx)).toBeUndefined();
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("forks a persistent steward at Ready and resumes it before sign-off", async () => {
		const flow = setup(["Ready"]);
		flow.bus.on("subagents:rpc:v1:request", (value: unknown) => {
			const request = value as { requestId: string; method: string; params: Record<string, unknown> };
			const runId = request.method === "spawn" ? "plan-review-run" : "signoff-review-run";
			flow.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				success: true,
				data: { details: { runId } },
			});
		});
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("steward on", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## User-visible result\n\nA file exists.\n\n## Goals\n\n1. [ ] goal: make the file\n  - discriminator: the file can be read\n");

			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({
				phase: "reviewing",
				stewardReview: { kind: "plan", runId: "plan-review-run" },
			});
			expect(flow.messages.some((message) => message.content.includes("Work the goals"))).toBe(false);
			const blockedDuringReview = await flow.hooks.get("tool_call")({ toolName: "write", input: { path: "README.md" } }, flow.ctx);
			expect(blockedDuringReview?.block).toBe(true);
			const reviewContext = await flow.hooks.get("before_agent_start")({}, flow.ctx);
			expect(reviewContext.message.content).toContain("[PLAN STEWARD REVIEW]");

			flow.bus.emit("subagent:async-complete", {
				runId: "plan-review-run",
				success: true,
				results: [{ structuredOutput: {
					decision: "approve",
					reason: "The goals preserve the requested result.",
					nextAction: "Start work.",
					contractDrift: [],
					unresolvedDecisions: [],
				} }],
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", stewardRunId: "plan-review-run" });
			expect(flow.messages.some((message) => message.content.includes("Work the goals"))).toBe(true);

			const firstSignoff = await flow.tools.get("CompleteGoal").execute("", { goal: "make the file" }, undefined, undefined, flow.ctx);
			expect(firstSignoff.isError).toBe(false);
			expect(firstSignoff.content[0].text).toContain("Sign-off paused");
			expect(flow.entries.at(-1)?.data).toMatchObject({
				stewardReview: { kind: "signoff", runId: "signoff-review-run", goal: "make the file" },
			});

			flow.bus.emit("subagent:async-complete", {
				runId: "signoff-review-run",
				success: true,
				results: [{ structuredOutput: {
					decision: "approve",
					reason: "The sign-off remains in scope.",
					nextAction: "Run the fresh evidence review.",
					contractDrift: [],
					unresolvedDecisions: [],
				} }],
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(flow.entries.at(-1)?.data).toMatchObject({
				stewardRunId: "signoff-review-run",
				stewardApproval: { goal: "make the file" },
			});
			expect(flow.messages.at(-1)?.content).toContain("Call CompleteGoal again");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("invalidates a plan approval when the human corrects it during review", async () => {
		const flow = setup(["Ready"]);
		flow.bus.on("subagents:rpc:v1:request", (value: unknown) => {
			const request = value as { requestId: string };
			flow.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1, requestId: request.requestId, success: true, data: { details: { runId: "review-run" } },
			});
		});
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("steward on", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: make the file\n\n## Log\n\n## Interview\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.hooks.get("input")({ text: "The file must be CSV.", source: "interactive" }, flow.ctx);
			flow.bus.emit("subagent:async-complete", {
				runId: "review-run",
				success: true,
				results: [{ structuredOutput: {
					decision: "approve", reason: "The old plan was sound.", nextAction: "Start.", contractDrift: [], unresolvedDecisions: [],
				} }],
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning" });
			expect(flow.messages.some((message) => message.content.includes("Work the goals"))).toBe(false);
			expect(flow.messages.at(-1)?.content).toContain("plan changed while the steward reviewed it");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("reconciles a completed pending steward review after session restart", async () => {
		const flow = setup([]);
		const methods: string[] = [];
		flow.bus.on("subagents:rpc:v1:request", (value: unknown) => {
			const request = value as { requestId: string; method: string };
			methods.push(request.method);
			if (request.method === "resume") {
				flow.bus.emit("subagent:async-complete", {
					runId: "lost-review",
					success: true,
					results: [{ structuredOutput: {
						decision: "approve", reason: "Stale completion.", nextAction: "Start.", contractDrift: [], unresolvedDecisions: [],
					} }],
				});
			}
			flow.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				success: true,
				data: request.method === "status" ? { text: "State: complete" } : { details: { runId: "recovered-review" } },
			});
		});
		try {
			mkdirSync(join(flow.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(join(flow.cwd, ".pi/plan/session-a-v1.md"), "# Plan\n\n## Goals\n\n1. [ ] goal: make the file\n");
			flow.entries.push({
				type: "custom",
				customType: "pi-goals-state",
				data: {
					phase: "reviewing", judgeModel: null, planVersion: 1, autoIntervalMs: null, autoPaused: false,
					stewardEnabled: true, stewardRunId: "lost-review", approvedPlan: null, stewardApproval: null,
					stewardReview: { kind: "plan", runId: "lost-review", snapshotHash: "old" },
				},
			});
			await flow.hooks.get("session_start")({}, flow.ctx);
			expect(methods).toEqual(["status", "resume"]);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "reviewing", stewardReview: { runId: "recovered-review" } });
			expect(flow.messages.some((message) => message.content.includes("Work the goals"))).toBe(false);
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("resumes the same steward after it requests a plan revision", async () => {
		const flow = setup(["Ready", "Ready"]);
		const methods: string[] = [];
		flow.bus.on("subagents:rpc:v1:request", (value: unknown) => {
			const request = value as { requestId: string; method: string };
			methods.push(request.method);
			flow.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				success: true,
				data: { details: { runId: methods.length === 1 ? "first-review" : "revised-review" } },
			});
		});
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("steward on", flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: make it better\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			flow.bus.emit("subagent:async-complete", {
				runId: "first-review",
				success: true,
				results: [{ structuredOutput: {
					decision: "revise_plan",
					reason: "The result is not observable.",
					nextAction: "Name the artifact.",
					contractDrift: [],
					unresolvedDecisions: [],
				} }],
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "planning", stewardRunId: "first-review" });
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: create report.html\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			expect(methods).toEqual(["spawn", "resume"]);
			expect(flow.entries.at(-1)?.data).toMatchObject({ stewardReview: { runId: "revised-review" } });
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("refuses to enable a steward after an unreviewed plan is already working", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.hooks.get("session_start")({}, flow.ctx);
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [ ] goal: make the file\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.commands.get("goals").handler("steward on", flow.ctx);
			expect(flow.entries.at(-1)?.data).toMatchObject({ phase: "working", stewardEnabled: false, stewardRunId: null });
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

	it("reminds every eight unchanged working-set turns, ignoring log-only edits", async () => {
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n\n## Log\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);

			await flow.hooks.get("turn_end")({}, flow.ctx);
			for (let turn = 0; turn < 3; turn++) await flow.hooks.get("turn_end")({}, flow.ctx);
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n\n## Log\n- checked input\n");
			for (let turn = 0; turn < 5; turn++) await flow.hooks.get("turn_end")({}, flow.ctx);

			const reminder = await flow.hooks.get("context")({ messages: [] }, flow.ctx);
			expect(reminder.messages.at(-1).content[0].text).toContain(".pi/plan/session-a-v1.md");

			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n  - [x] inspect input\n\n## Log\n- checked input\n");
			await flow.hooks.get("turn_end")({}, flow.ctx);
			for (let turn = 0; turn < 7; turn++) await flow.hooks.get("turn_end")({}, flow.ctx);
			expect((await flow.hooks.get("context")({ messages: [] }, flow.ctx)).messages).toHaveLength(0);
			await flow.hooks.get("turn_end")({}, flow.ctx);
			expect((await flow.hooks.get("context")({ messages: [] }, flow.ctx)).messages.at(-1).content[0].text).toContain("make the output");
		} finally {
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("auto-continues once on stop, then pauses after two no-progress wakes", async () => {
		vi.useFakeTimers();
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.commands.get("goals").handler("auto 1", flow.ctx);

			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await vi.advanceTimersByTimeAsync(0);
			const autoMessages = () => flow.messages.filter((message) => message.content.includes("Auto-continue is enabled"));
			expect(autoMessages()).toHaveLength(1);

			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(autoMessages()).toHaveLength(2);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(autoMessages()).toHaveLength(2);
		} finally {
			vi.useRealTimers();
			rmSync(flow.cwd, { recursive: true, force: true });
		}
	});

	it("delays auto-continuation after a known background start", async () => {
		vi.useFakeTimers();
		const flow = setup(["Ready"]);
		try {
			await flow.commands.get("goals").handler("objective", flow.ctx);
			const planPath = join(flow.cwd, ".pi/plan/session-a-v1.md");
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: make the output\n");
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await flow.commands.get("goals").handler("auto 1", flow.ctx);
			await flow.hooks.get("agent_start")({}, flow.ctx);
			await flow.hooks.get("tool_call")({ toolName: "process", input: { action: "start" } }, flow.ctx);
			await flow.hooks.get("agent_settled")({}, flow.ctx);
			await vi.advanceTimersByTimeAsync(0);
			const autoMessages = () => flow.messages.filter((message) => message.content.includes("Auto-continue is enabled"));
			expect(autoMessages()).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(autoMessages()).toHaveLength(1);
		} finally {
			vi.useRealTimers();
			rmSync(flow.cwd, { recursive: true, force: true });
		}
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
