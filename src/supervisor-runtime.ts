import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { goalBlock, hashGoalBlock, repositoryState, writeApproval } from "./approval.js";
import { isSupervisorReadOnlyCommand } from "./index.js";
import { registerGoalWorker, subagentWorkState } from "./worker.js";

const APPROVE_GOAL = "ApproveGoal";

function result(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

export default function goalSupervisorRuntime(pi: ExtensionAPI): void {
	let workerRegistration: { dispose(): void } | null = null;

	pi.on("session_start", async (_event, ctx) => {
		workerRegistration?.dispose();
		workerRegistration = registerGoalWorker(pi.events, null);
		ctx.ui.notify("Goal supervisor can now launch its retained worker.", "info");
	});

	pi.on("session_shutdown", async () => {
		workerRegistration?.dispose();
		workerRegistration = null;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			return { block: true, reason: "Goal supervision is read-only. Direct project changes to the nested goal-worker." };
		}
		if (event.toolName === "bash" && !isSupervisorReadOnlyCommand(String((event.input as { command?: string }).command))) {
			return { block: true, reason: "Goal supervision allows inspection and standard verification commands only. This is not a full sandbox for custom tools or allowed scripts." };
		}
	});

	pi.registerTool({
		name: APPROVE_GOAL,
		label: "Approve goal",
		description: "Record an auditable approval only after the supervisor inspected the plan, repository, cited evidence, and saved verification output. It fails closed while nested work is active or the repository is dirty.",
		parameters: Type.Object({
			goal: Type.String({ description: "Exact current goal text from the approved plan." }),
			planPath: Type.String({ description: "Absolute path to the current plan file." }),
			checkpointPath: Type.String({ description: "Exact private approval-record path supplied by the main coordinator for this goal." }),
			inspectedPlan: Type.Literal(true),
			inspectedRepository: Type.Literal(true),
			inspectedEvidence: Type.Literal(true),
			inspectedVerifyOutput: Type.Literal(true),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const workState = await subagentWorkState(pi.events);
			if (workState !== "idle") return result(`Cannot approve while nested worker status is ${workState}.`, true);
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
			const record = {
				version: 1 as const,
				verdict: "accept" as const,
				goal: params.goal,
				planPath,
				goalBlockHash: hashGoalBlock(block),
				repoRoot: repository.repoRoot,
				head: repository.head,
				tree: repository.tree,
				cleanWorktree: true as const,
				inspected: { plan: true as const, repository: true as const, evidence: true as const, verifyOutput: true as const },
				supervisor: { sessionId: ctx.sessionManager.getSessionId(), runId: process.env.PI_SUBAGENT_RUN_ID ?? null },
				timestamp: new Date().toISOString(),
			};
			const path = resolve(params.checkpointPath);
			const approvalRoot = resolve(ctx.cwd, ".pi", "pi-goals", "approvals");
			if (!path.startsWith(`${approvalRoot}/`)) return result("Approval checkpoint must stay in private .pi/pi-goals/approvals state.", true);
			writeApproval(path, record);
			return result(`Approval recorded at ${path} for "${params.goal}".`);
		},
	});
}
