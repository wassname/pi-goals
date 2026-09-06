import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalPath, readApproval } from "../src/approval.js";
import supervisorRuntime from "../src/supervisor-runtime.js";
import { GOAL_WORKER_AGENT } from "../src/worker.js";

class Events {
	private handlers = new Map<string, Set<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goals-supervisor-"));
	writeFileSync(join(cwd, "README.md"), "test\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "README.md"], { cwd });
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
	const hooks = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const branch: any[] = [];
	const compactCalls: any[] = [];
	const events = new Events();
	events.on("processes:request:list", (raw) => {
		(raw as { reply(value: object[]): void }).reply([]);
	});
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "supervisor-session", getEntries: () => entries, getBranch: () => branch },
		compact: (options: any) => compactCalls.push(options),
		ui: { notify() {} },
	};
	const pi = {
		events,
		on: (name: string, handler: any) => hooks.set(name, handler),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerTool: (tool: any) => tools.set(tool.name, tool),
	};
	supervisorRuntime(pi as any);
	return { cwd, ctx, events, hooks, tools, entries, branch, compactCalls };
}

describe("supervisor-only runtime", () => {
	it("blocks direct supervisor writes", async () => {
		const runtime = setup();
		try {
			expect((await runtime.hooks.get("tool_call")({ toolName: "edit", input: { path: "README.md" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "bash", input: { command: "git branch new-name" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "wrong", input: { agent: "goal-worker", task: "work", async: false, context: "fork" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "implicit", input: { agent: GOAL_WORKER_AGENT, task: "work" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "model", input: { agent: GOAL_WORKER_AGENT, task: "work", async: false, context: "fork", model: "other/model" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "override", input: { agent: GOAL_WORKER_AGENT, task: "work", async: false, context: "fork", worktree: true } }, runtime.ctx))?.block).toBe(true);
			expect(await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "worker", input: { agent: GOAL_WORKER_AGENT, task: "work", async: false, context: "fork" } }, runtime.ctx)).toBeUndefined();
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "duplicate", input: { agent: GOAL_WORKER_AGENT, task: "work", async: false, context: "fork" } }, runtime.ctx))?.block).toBe(true);
			await runtime.hooks.get("tool_result")({ toolName: "subagent", toolCallId: "worker", isError: true }, runtime.ctx);
			expect(await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "stale", input: { agent: GOAL_WORKER_AGENT, task: "work", async: false, context: "fork" } }, runtime.ctx)).toBeUndefined();
			await runtime.hooks.get("turn_start")({ turnIndex: 1 }, runtime.ctx);
			expect(await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "recovered", input: { agent: GOAL_WORKER_AGENT, task: "work", async: false, context: "fork" } }, runtime.ctx)).toBeUndefined();
			await runtime.hooks.get("tool_result")({ toolName: "subagent", toolCallId: "recovered", isError: true }, runtime.ctx);
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "async", input: { agent: GOAL_WORKER_AGENT, task: "work", async: true, context: "fork" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "resume", input: { action: "resume", id: "nested-1" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "bash", input: { command: "git status && npm test" } }, runtime.ctx))).toBeUndefined();
		} finally {
			rmSync(runtime.cwd, { recursive: true, force: true });
		}
	});

	it("compacts a requested fork before the first supervisor turn", async () => {
		const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
		process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-goals/1": { compactPlanning: true, workerModel: "provider/worker" } });
		const runtime = setup();
		try {
			await runtime.hooks.get("session_start")({}, runtime.ctx);
			expect(await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "wrong-model", input: { agent: GOAL_WORKER_AGENT, task: "work", async: false, context: "fork", model: "other/model" } }, runtime.ctx)).toMatchObject({ block: true });
			expect(await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "worker", input: { agent: GOAL_WORKER_AGENT, task: "work", async: false, context: "fork", model: "provider/worker" } }, runtime.ctx)).toBeUndefined();
		await runtime.hooks.get("tool_result")({ toolName: "subagent", toolCallId: "worker", isError: true }, runtime.ctx);
			expect(runtime.compactCalls).toHaveLength(1);
			const replacement = await runtime.hooks.get("session_before_compact")({
				preparation: { firstKeptEntryId: "old", tokensBefore: 70_000 },
				branchEntries: [{ id: "recent", type: "message", message: { role: "assistant" } }],
			}, runtime.ctx);
			expect(replacement.compaction).toMatchObject({ firstKeptEntryId: "recent", tokensBefore: 70_000 });
			runtime.compactCalls[0].onComplete({});
			await runtime.hooks.get("before_agent_start")({}, runtime.ctx);
			expect(runtime.entries).toContainEqual({ type: "custom", customType: "pi-goals-supervisor-compacted", data: { version: 1 } });
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
			else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous;
			rmSync(runtime.cwd, { recursive: true, force: true });
		}
	});

	it("writes an approval only after inspecting the plan and confirming a clean worktree at a commit", async () => {
		const runtime = setup();
		const previousRunId = process.env.PI_SUBAGENT_RUN_ID;
		process.env.PI_SUBAGENT_RUN_ID = "supervisor-run";
		try {
			const planPath = join(runtime.cwd, ".pi/plan/session-a-v1.md");
			mkdirSync(join(runtime.cwd, ".pi/plan"), { recursive: true });
			writeFileSync(planPath, "# Plan\n\n## Goals\n\n1. [/] goal: ship it\n  - evidence: verify.log: PASS\n");
			const checkpoint = approvalPath(runtime.cwd, "main-session", "ship it");
			const params = {
				approvalId: "review-1",
				goal: "ship it",
				planPath,
				checkpointPath: checkpoint,
				inspectedPlan: true,
				inspectedRepository: true,
				inspectedEvidence: true,
				inspectedVerifyOutput: true,
			};
			await runtime.hooks.get("turn_start")({ turnIndex: 0 }, runtime.ctx);
			await runtime.hooks.get("tool_call")({ toolName: "subagent", toolCallId: "worker", input: { agent: GOAL_WORKER_AGENT, task: "work", async: false, context: "fork" } }, runtime.ctx);
			expect((await runtime.tools.get("ApproveGoal").execute("", params, undefined, undefined, runtime.ctx)).isError).toBe(true);
			await runtime.hooks.get("tool_result")({ toolName: "subagent", toolCallId: "worker", isError: false }, runtime.ctx);
			expect((await runtime.tools.get("ApproveGoal").execute("", params, undefined, undefined, runtime.ctx)).isError).toBe(true);
			await runtime.hooks.get("turn_start")({ turnIndex: 1 }, runtime.ctx);
			runtime.branch.push({
				type: "message",
				message: { role: "assistant", content: [
					{ type: "toolCall", name: "ApproveGoal", arguments: params },
					{ type: "toolCall", name: "subagent", arguments: { agent: GOAL_WORKER_AGENT, task: "more work", async: false, context: "fork" } },
				] },
			});
			expect((await runtime.tools.get("ApproveGoal").execute("", params, undefined, undefined, runtime.ctx)).isError).toBe(true);
			await runtime.hooks.get("turn_start")({ turnIndex: 2 }, runtime.ctx);
			runtime.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ApproveGoal", arguments: params }] } });
			const accepted = await runtime.tools.get("ApproveGoal").execute("", params, undefined, undefined, runtime.ctx);

			expect(runtime.tools.get("ApproveGoal").executionMode).toBe("sequential");
			expect(accepted.isError).toBe(false);
			expect(readApproval(checkpoint)).toMatchObject({ version: 2, approvalId: "review-1", goal: "ship it", supervisor: { sessionId: "supervisor-session", runId: "supervisor-run" } });
			expect(readFileSync(checkpoint, "utf8")).toContain('"goalBlockHash"');
		} finally {
			if (previousRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
			else process.env.PI_SUBAGENT_RUN_ID = previousRunId;
			rmSync(runtime.cwd, { recursive: true, force: true });
		}
	});
});
