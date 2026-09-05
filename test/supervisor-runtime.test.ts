import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalPath, readApproval } from "../src/approval.js";
import supervisorRuntime from "../src/supervisor-runtime.js";

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
	const compactCalls: any[] = [];
	const events = new Events();
	events.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as any;
		events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			success: true,
			data: { text: "idle", asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 0, children: 0, byteLimitExceeded: false }, runs: [] } },
		});
	});
	events.on("processes:request:list", (raw) => {
		(raw as { reply(value: object[]): void }).reply([]);
	});
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "supervisor-session", getEntries: () => entries },
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
	return { cwd, ctx, events, hooks, tools, entries, compactCalls };
}

describe("supervisor-only runtime", () => {
	it("blocks direct supervisor writes", async () => {
		const runtime = setup();
		try {
			expect((await runtime.hooks.get("tool_call")({ toolName: "edit", input: { path: "README.md" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "bash", input: { command: "git branch new-name" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", input: { agent: "worker" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", input: { agent: "goal-worker" } }, runtime.ctx))).toBeUndefined();
			expect((await runtime.hooks.get("tool_call")({ toolName: "subagent", input: { action: "status", id: "nested-1" } }, runtime.ctx))?.block).toBe(true);
			expect((await runtime.hooks.get("tool_call")({ toolName: "bash", input: { command: "git status && npm test" } }, runtime.ctx))).toBeUndefined();
		} finally {
			rmSync(runtime.cwd, { recursive: true, force: true });
		}
	});

	it("compacts a requested fork before the first supervisor turn", async () => {
		const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
		process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-goals/1": { compactPlanning: true } });
		const runtime = setup();
		try {
			await runtime.hooks.get("session_start")({}, runtime.ctx);
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

	it("blocks approval while its retained worker is pending", async () => {
		const runtime = setup();
		try {
			runtime.events.emit("subagent:async-started", { id: "nested-1", agent: "goal-worker" });
			const state = await runtime.tools.get("CheckWorkerState").execute("", {}, undefined, undefined, runtime.ctx);
			expect(state.content[0].text).toBe("retained-worker=active; run=nested-1");
			const blocked = await runtime.tools.get("ApproveGoal").execute("", {}, undefined, undefined, runtime.ctx);
			expect(blocked.isError).toBe(true);
			expect(blocked.content[0].text).toContain("retained worker is pending");
		} finally {
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
			runtime.events.emit("subagent:async-started", { id: "nested-1", agent: "goal-worker" });
			runtime.events.emit("subagent:process-terminal", { runId: "nested-1", state: "observed" });
			const state = await runtime.tools.get("CheckWorkerState").execute("", {}, undefined, undefined, runtime.ctx);
			expect(state.content[0].text).toBe("retained-worker=terminal; run=nested-1");
			const accepted = await runtime.tools.get("ApproveGoal").execute("", {
				approvalId: "review-1",
				goal: "ship it",
				planPath,
				checkpointPath: checkpoint,
				inspectedPlan: true,
				inspectedRepository: true,
				inspectedEvidence: true,
				inspectedVerifyOutput: true,
			}, undefined, undefined, runtime.ctx);

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
