import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approvalPath, goalBlock, hashGoalBlock, repositoryState, writeApproval } from "./approval.js";

const BOOTSTRAPPED = "pi-goals-visible-supervisor-v1";
const COMPACT_AT_TOKENS = 100_000;

interface SupervisorConfig {
	workerSessionId: string;
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
		ownerSessionId: requiredEnv("PI_GOALS_OWNER_SESSION_ID"),
		planPath: resolve(requiredEnv("PI_GOALS_PLAN_PATH")),
		approvalId: requiredEnv("PI_GOALS_APPROVAL_ID"),
	};
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
	return `You are the visible pi-goals supervisor for ${settings.planPath}. You are a stronger, read-only reviewer. The other Pi session is the implementation worker and keeps the full conversation. You keep the high-level intent from the compacted planning conversation, the complete plan, and pi-supervise worker views.

Use pi-supervise to inspect and steer the worker. Give one concrete instruction when work is incomplete. Do not edit files. For each open goal, inspect its exact plan block, repository state, cited evidence, and saved verify output. When its discriminator is positively satisfied and the worker view says no work is active, call ApproveGoal. Then call steer and tell the worker to call CompleteGoal with the exact goal text. Do not call done until every plan goal is [x]. -- PI[gpt-5.6-sol]`;
}

export function isVisibleSupervisor(): boolean {
	return process.env.PI_GOALS_ROLE === "supervisor";
}

export function registerVisibleSupervisor(pi: ExtensionAPI): void {
	const settings = config();
	let compacting = false;

	pi.on("before_agent_start", async (_event, ctx) => ({
		systemPrompt: `${ctx.getSystemPrompt()}\n\n${supervisorPrompt(settings)}`,
	}));

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		if (entries.some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === BOOTSTRAPPED)) return;
		if (!pi.getCommands().some((command) => command.name === "supervise" && command.source === "extension")) {
			ctx.ui.notify("pi-goals supervisor needs the @wassname2/pi-supervise extension.", "error");
			return;
		}
		compacting = true;
		ctx.compact({
			customInstructions: `Preserve the user's decisions, preferences, and high-level objective from planning. Preserve unresolved risks and the plan path ${settings.planPath}. Remove implementation chatter. This summary is for a read-only supervisor that will judge and steer another Pi session.`,
			onComplete: () => {
				compacting = false;
				pi.appendEntry(BOOTSTRAPPED, { version: 1, workerSessionId: settings.workerSessionId, planPath: settings.planPath });
				const sendCommand = pi.sendUserMessage as (content: string, options: { expandPromptTemplates: boolean }) => void;
				sendCommand(`/supervise @${settings.workerSessionId} ${settings.planPath}`, { expandPromptTemplates: true });
			},
			onError: (error) => {
				compacting = false;
				ctx.ui.notify(`Supervisor compaction failed: ${error.message}`, "error");
			},
		});
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
		description: "Record approval after inspecting the current goal, repository, evidence, saved verify output, and a stopped worker view with no active work.",
		parameters: Type.Object({
			goal: Type.String({ description: "Exact text after goal: in the plan." }),
			inspectedPlan: Type.Literal(true),
			inspectedRepository: Type.Literal(true),
			inspectedEvidence: Type.Literal(true),
			inspectedVerifyOutput: Type.Literal(true),
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
			if (/evidence:\s*\(empty until sign-off\)/i.test(block)) return result("Cannot approve while the goal evidence is empty.", true);
			const path = approvalPath(ctx.cwd, settings.ownerSessionId, params.goal);
			writeApproval(path, {
				version: 2,
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
				supervisor: { sessionId: ctx.sessionManager.getSessionId(), runId: null },
				timestamp: new Date().toISOString(),
			});
			return result(`Approval recorded for "${params.goal}". Now steer the worker to call CompleteGoal.`);
		},
	});
}
