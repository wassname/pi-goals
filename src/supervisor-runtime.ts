import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { goalBlock, hashGoalBlock, repositoryState, writeApproval } from "./approval.js";
import { isSupervisorReadOnlyCommand } from "./index.js";
import { GOAL_WORKER_AGENT, processWorkState } from "./worker.js";

const COMPACTED_STATE = "pi-goals-supervisor-compacted";

function result(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

interface GoalBindings {
	compactPlanning?: boolean;
	workerModel?: string | null;
}

function goalBindings(): GoalBindings {
	const raw = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
	if (!raw) return {};
	const binding = (JSON.parse(raw) as { "pi-goals/1"?: GoalBindings })["pi-goals/1"] ?? {};
	if (binding.workerModel !== undefined && binding.workerModel !== null && typeof binding.workerModel !== "string") throw new Error("pi-goals workerModel binding must be a string or null.");
	return binding;
}

function messageLaunchesWorker(ctx: { sessionManager: { getBranch(): unknown[] } }): boolean {
	const entry = [...ctx.sessionManager.getBranch()].reverse().find((candidate) => {
		const value = candidate as { type?: unknown; message?: { role?: unknown } };
		return value.type === "message" && value.message?.role === "assistant";
	}) as { message?: { content?: unknown } } | undefined;
	if (!Array.isArray(entry?.message?.content)) return false;
	return entry.message.content.some((part) => {
		const value = part as { type?: unknown; name?: unknown; arguments?: Record<string, unknown> };
		return value.type === "toolCall" && value.name === "subagent" && value.arguments?.agent === GOAL_WORKER_AGENT;
	});
}

export default function goalSupervisorRuntime(pi: ExtensionAPI): void {
	let compacting = false;
	let compactionDone = Promise.resolve();
	let currentTurn = -1;
	let completedWorkerTurn: number | null = null;
	let workerModel: string | null = null;
	const activeWorkerCalls = new Set<string>();

	pi.on("session_before_compact", async (event) => {
		if (!compacting) return;
		const branchEntries = event.branchEntries as Array<{ id?: string; type?: string; message?: { role?: string } }>;
		const latestMessage = [...branchEntries].reverse().find((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message?.role ?? ""));
		return {
			compaction: {
				summary: "Planning is complete. The latest retained goal-supervisor task contains the current plan and approval paths; use it as the source of truth. -- PI[gpt-5.6-sol]",
				firstKeptEntryId: latestMessage?.id ?? event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { source: "pi-goals-plan-handoff" },
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const bindings = goalBindings();
		workerModel = bindings.workerModel ?? null;
		if (bindings.compactPlanning !== true) return;
		if (entries.some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === COMPACTED_STATE)) return;
		compacting = true;
		compactionDone = new Promise<void>((resolvePromise, reject) => {
			ctx.compact({
				onComplete: () => {
					compacting = false;
					pi.appendEntry(COMPACTED_STATE, { version: 1 });
					resolvePromise();
				},
				onError: (error) => {
					compacting = false;
					reject(error);
				},
			});
		});
	});

	pi.on("before_agent_start", async () => {
		await compactionDone;
	});

	pi.on("turn_start", async (event) => {
		activeWorkerCalls.clear();
		currentTurn = event.turnIndex;
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
		const allowedKeys = new Set(["agent", "task", "async", "context", ...(workerModel ? ["model"] : [])]);
		const unexpectedKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
		const validWorker = input.agent === GOAL_WORKER_AGENT
			&& typeof input.task === "string"
			&& input.task.trim().length > 0
			&& input.async === false
			&& input.context === "fork"
			&& (workerModel ? input.model === workerModel : input.model === undefined)
			&& unexpectedKeys.length === 0;
		if (!validWorker) {
			const model = workerModel ? `, model:${JSON.stringify(workerModel)}` : "";
			return { block: true, reason: `Launch only ${GOAL_WORKER_AGENT} with task, async:false, context:"fork"${model}, and no other fields.` };
		}
		if (activeWorkerCalls.size > 0) return { block: true, reason: "A foreground goal-worker is already running." };
		activeWorkerCalls.add(event.toolCallId);
		completedWorkerTurn = null;
	});

	pi.on("tool_result", async (event) => {
		if (!activeWorkerCalls.delete(event.toolCallId)) return;
		if (!event.isError) completedWorkerTurn = currentTurn;
	});

	pi.registerTool({
		name: "ApproveGoal",
		label: "Approve goal",
		executionMode: "sequential",
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
			if (messageLaunchesWorker(ctx) || activeWorkerCalls.size > 0 || completedWorkerTurn === null || completedWorkerTurn >= currentTurn) {
				return result("Cannot approve in a worker-launch message or before reviewing a finished worker on a later turn.", true);
			}
			const processes = processWorkState(pi.events);
			if (processes !== "idle") return result(`Cannot approve: processes=${processes}.`, true);
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
