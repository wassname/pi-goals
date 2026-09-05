import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { goalBlock, hashGoalBlock, repositoryState, writeApproval } from "./approval.js";
import { isSupervisorReadOnlyCommand } from "./index.js";
import { processWorkState, subagentWorkState } from "./worker.js";

const NESTED_STATE = "pi-goals-nested-worker";

interface NestedState {
	runId: string | null;
	pending: boolean;
}

function result(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function targetRun(input: Record<string, unknown>): string | null {
	const value = input.id ?? input.runId;
	return typeof value === "string" && value ? value : null;
}

export default function goalSupervisorRuntime(pi: ExtensionAPI): void {
	let nested: NestedState = { runId: null, pending: false };
	const persist = () => pi.appendEntry<NestedState>(NESTED_STATE, nested);

	pi.events.on("subagent:async-started", (raw) => {
		const event = raw as { id?: unknown; agent?: unknown };
		if (event.agent !== "goal-worker" || typeof event.id !== "string") return;
		nested = { runId: event.id, pending: true };
		persist();
	});
	pi.events.on("subagent:async-complete", (raw) => {
		if ((raw as { runId?: unknown }).runId !== nested.runId) return;
		nested = { ...nested, pending: false };
		persist();
	});

	pi.on("session_start", async (_event, ctx) => {
		const last = ctx.sessionManager.getEntries()
			.filter((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === NESTED_STATE)
			.pop() as { data?: NestedState } | undefined;
		nested = last?.data ?? nested;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			return { block: true, reason: "Goal supervision is read-only. Direct project changes to the nested goal-worker." };
		}
		if (event.toolName === "bash" && !isSupervisorReadOnlyCommand(String((event.input as { command?: string }).command))) {
			return { block: true, reason: "Goal supervision allows inspection and standard verification commands only." };
		}
		if (event.toolName !== "subagent") return;
		const input = event.input as Record<string, unknown>;
		const action = typeof input.action === "string" ? input.action : null;
		if (!action) {
			if (input.agent === "goal-worker" && !nested.runId && input.workflowScript === undefined && input.workflowScriptPath === undefined) return;
			return { block: true, reason: nested.runId ? "Resume the retained goal-worker instead of starting another worker." : "The supervisor may start only goal-worker." };
		}
		if (action === "list") return;
		if (action === "status" && (!targetRun(input) || targetRun(input) === nested.runId)) return;
		if (["resume", "steer", "interrupt", "stop"].includes(action) && targetRun(input) === nested.runId) return;
		return { block: true, reason: "The supervisor may inspect or control only its retained goal-worker." };
	});

	pi.registerTool({
		name: "ApproveGoal",
		label: "Approve goal",
		description: "Record approval after inspecting the plan, repository, evidence, and saved verification output. Active or unknown work blocks approval.",
		parameters: Type.Object({
			approvalId: Type.String({ minLength: 1, description: "Exact approval ID from the latest main-coordinator direction." }),
			goal: Type.String({ description: "Exact current goal text from the approved plan." }),
			planPath: Type.String({ description: "Absolute path to the current plan file." }),
			checkpointPath: Type.String({ description: "Exact private approval-record path supplied by the main coordinator." }),
			inspectedPlan: Type.Literal(true),
			inspectedRepository: Type.Literal(true),
			inspectedEvidence: Type.Literal(true),
			inspectedVerifyOutput: Type.Literal(true),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (nested.pending) return result("Cannot approve while the retained worker is pending.", true);
			const [subagents, processes] = await Promise.all([subagentWorkState(pi.events), Promise.resolve(processWorkState(pi.events))]);
			if (subagents !== "idle" || processes !== "idle") return result(`Cannot approve: subagents=${subagents}; processes=${processes}.`, true);
			const planPath = resolve(params.planPath);
			let plan: string;
			let repository: ReturnType<typeof repositoryState>;
			try {
				plan = readFileSync(planPath, "utf8");
				repository = repositoryState(ctx.cwd);
			} catch (error) {
				return result(`Cannot inspect approval inputs: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			if (!repository.cleanWorktree) return result("Cannot approve with a dirty worktree. Commit the worker changes first.", true);
			const block = goalBlock(plan, params.goal);
			if (!block) return result(`Cannot approve: no unique open goal matches "${params.goal}".`, true);
			const path = resolve(params.checkpointPath);
			const approvalRoot = resolve(ctx.cwd, ".pi", "pi-goals", "approvals");
			if (!path.startsWith(`${approvalRoot}/`)) return result("Approval checkpoint must stay in private .pi/pi-goals/approvals state.", true);
			writeApproval(path, {
				version: 2,
				verdict: "accept",
				approvalId: params.approvalId,
				goal: params.goal,
				planPath,
				goalBlockHash: hashGoalBlock(block),
				repoRoot: repository.repoRoot,
				head: repository.head,
				tree: repository.tree,
				cleanWorktree: true,
				inspected: { plan: true, repository: true, evidence: true, verifyOutput: true },
				supervisor: { sessionId: ctx.sessionManager.getSessionId(), runId: process.env.PI_SUBAGENT_RUN_ID ?? null },
				timestamp: new Date().toISOString(),
			});
			return result(`Approval recorded at ${path} for "${params.goal}".`);
		},
	});
}
