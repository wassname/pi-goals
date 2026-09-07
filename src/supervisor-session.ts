import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approvalPath, goalBlock, hashGoalBlock, repositoryState, verifyOutputPath, writeApproval } from "./approval.js";
import { pairWithPiSupervise } from "./supervise.js";

const BOOTSTRAPPED = "pi-goals-visible-supervisor-v1";
const INITIAL_COMPACT_AT_TOKENS = 20_000;
const COMPACT_AT_TOKENS = 100_000;

interface SupervisorConfig {
	workerSessionId: string;
	workerIntercomId: string;
	ownerSessionId: string;
	planPath: string;
	approvalId: string;
}

function result(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required in a pi-goals supervisor session.`);
	return value;
}

function config(): SupervisorConfig {
	return {
		workerSessionId: requiredEnv("PI_GOALS_WORKER_ID"),
		workerIntercomId: requiredEnv("PI_GOALS_WORKER_INTERCOM_ID"),
		ownerSessionId: requiredEnv("PI_GOALS_OWNER_SESSION_ID"),
		planPath: resolve(requiredEnv("PI_GOALS_PLAN_PATH")),
		approvalId: requiredEnv("PI_GOALS_APPROVAL_ID"),
	};
}

function hasEvidenceEntry(block: string): boolean {
	const lines = block.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const evidence = /^\s*[-*]\s+evidence:\s*(.*)$/i.exec(lines[index]);
		if (!evidence) continue;
		if (evidence[1].trim() && !/^\(empty until sign-off\)$/i.test(evidence[1].trim())) return true;
		const indent = lines[index].match(/^\s*/)?.[0].length ?? 0;
		for (let child = index + 1; child < lines.length; child++) {
			const childIndent = lines[child].match(/^\s*/)?.[0].length ?? 0;
			if (lines[child].trim() && childIndent <= indent) break;
			const entry = /^\s+[-*]\s+(.+?)\s*$/.exec(lines[child]);
			if (entry?.[1].trim()) return true;
		}
	}
	return false;
}

function latestWorkerView(ctx: ExtensionContext): string | null {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		const message = (entry as { type?: string; message?: { role?: string; content?: unknown[] } }).message;
		if ((entry as { type?: string }).type !== "message" || message?.role !== "user" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const text = (part as { type?: string; text?: string }).type === "text" ? (part as { text?: string }).text : undefined;
			if (text?.startsWith("The worker ")) return text;
		}
	}
	return null;
}

function supervisorPrompt(settings: SupervisorConfig): string {
	return `You are the visible pi-goals supervisor for ${settings.planPath}. You are a stronger, read-only reviewer. The other Pi session is the implementation worker and keeps the full conversation. You keep the high-level intent from the compacted planning conversation and pi-supervise worker views. The complete plan at ${settings.planPath} is the source of truth; read it directly after every compaction.

Use pi-supervise to inspect and steer the worker. Give one concrete instruction when work is incomplete. Do not edit files. For each open goal, inspect its exact plan block, repository state, cited evidence, and a saved nonempty verification-output file. When its discriminator is positively satisfied and the worker view says no work is active, call ApproveGoal with that repository-relative path. Then call steer and tell the worker to call CompleteGoal with the exact goal text. Do not call done until every plan goal is [x]. -- PI[gpt-5.6-sol]`;
}

export function isVisibleSupervisor(): boolean {
	return process.env.PI_GOALS_ROLE === "supervisor";
}

export function registerVisibleSupervisor(pi: ExtensionAPI): void {
	const settings = config();
	let compacting = false;
	let bootstrapping = false;

	const bootstrap = async (ctx: ExtensionContext): Promise<void> => {
		if (bootstrapping) return;
		const entries = ctx.sessionManager.getEntries();
		if (entries.some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === BOOTSTRAPPED)) return;
		bootstrapping = true;
		try {
			await pairWithPiSupervise(pi, settings.workerIntercomId, settings.planPath);
			pi.appendEntry(BOOTSTRAPPED, { version: 1, workerSessionId: settings.workerSessionId, planPath: settings.planPath });
			pi.sendUserMessage("Supervision is paired. Inspect the worker and give its next concrete instruction.");
		} catch (error) {
			ctx.ui.notify(`Supervisor startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	const bootstrapAfterInitialCompaction = (ctx: ExtensionContext): void => {
		const tokens = ctx.getContextUsage()?.tokens;
		if (typeof tokens === "number" && tokens <= INITIAL_COMPACT_AT_TOKENS) {
			void bootstrap(ctx);
			return;
		}
		compacting = true;
		ctx.compact({
			customInstructions: `Preserve the user's high-level intent, decisions, unresolved risks, and the supervisor's remit. The canonical plan is ${settings.planPath}; it remains available directly and must not be replaced by this summary.`,
			onComplete: () => {
				compacting = false;
				ctx.ui.notify("Supervisor planning context compacted before work started.", "info");
				void bootstrap(ctx);
			},
			onError: (error) => {
				compacting = false;
				ctx.ui.notify(`Supervisor startup compaction failed: ${error.message}`, "error");
			},
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		setImmediate(() => { bootstrapAfterInitialCompaction(ctx); });
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		return { systemPrompt: `${ctx.getSystemPrompt()}\n\n${supervisorPrompt(settings)}` };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (compacting || (ctx.getContextUsage()?.tokens ?? 0) < COMPACT_AT_TOKENS) return;
		compacting = true;
		ctx.compact({
			customInstructions: `Keep the user's high-level intent, current plan state, unresolved risks, approval decisions, and the supervisor's own concise findings. Remove old worker views and implementation detail.`,
			onComplete: () => {
				compacting = false;
				ctx.ui.notify("Supervisor context compacted at 100k tokens.", "info");
			},
			onError: (error) => {
				compacting = false;
				ctx.ui.notify(`Supervisor compaction failed: ${error.message}`, "error");
			},
		});
	});

	pi.registerTool({
		name: "ApproveGoal",
		label: "Approve goal",
		executionMode: "sequential",
		description: "Record approval after inspecting the current goal, repository, evidence, and a saved nonempty verification-output file, with a stopped worker view and no active work.",
		parameters: Type.Object({
			goal: Type.String({ description: "Exact text after goal: in the plan." }),
			verifyOutputPath: Type.String({ description: "Nonempty repository-relative file containing the verification output you inspected." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const view = latestWorkerView(ctx);
			if (!view?.startsWith("The worker stopped.")) return result("Cannot approve without a current stopped-worker view.", true);
			const pendingTool = view.match(/^tool calls with no result: (?!none$)(.+)$/m);
			const pendingChild = view.match(/^child pi processes still running: (?!none$)(.+)$/m);
			if (pendingTool || pendingChild) return result(`Cannot approve while work is active: ${(pendingTool ?? pendingChild)![1]}`, true);
			let plan: string;
			let repository: ReturnType<typeof repositoryState>;
			try {
				plan = readFileSync(settings.planPath, "utf8");
				repository = repositoryState(ctx.cwd);
			} catch (error) {
				return result(`Cannot inspect approval inputs: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			if (!repository.cleanWorktree) return result("Cannot approve with a dirty worktree. Commit the worker changes first.", true);
			const block = goalBlock(plan, params.goal);
			if (!block) return result(`Cannot approve: no unique open goal matches "${params.goal}".`, true);
			if (!hasEvidenceEntry(block)) return result("Cannot approve without a nonblank evidence entry in the goal block.", true);
			const verifiedOutput = verifyOutputPath(repository.repoRoot, params.verifyOutputPath);
			if (!verifiedOutput) return result("Cannot approve without a nonempty repository-relative verification-output file.", true);
			const path = approvalPath(ctx.cwd, settings.ownerSessionId, params.goal);
			writeApproval(path, {
				version: 3,
				verdict: "accept",
				approvalId: settings.approvalId,
				goal: params.goal,
				planPath: settings.planPath,
				goalBlockHash: hashGoalBlock(block),
				repoRoot: repository.repoRoot,
				head: repository.head,
				tree: repository.tree,
				cleanWorktree: true,
				inspected: { plan: true, repository: true, evidence: true, verifyOutput: true },
				verifyOutputPath: verifiedOutput,
				supervisor: { sessionId: ctx.sessionManager.getSessionId(), runId: null },
				timestamp: new Date().toISOString(),
			});
			return result(`Approval recorded for "${params.goal}". Now steer the worker to call CompleteGoal.`);
		},
	});
}
