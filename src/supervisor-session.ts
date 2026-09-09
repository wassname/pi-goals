import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { approvalPath, goalBlock, hashGoalBlock, repositoryState, verifyOutputPath, writeApproval } from "./approval.js";
import { GoalIntercom } from "./intercom.js";
import { RoleModels } from "./role-models.js";

const BOOTSTRAPPED = "pi-goals-visible-supervisor-v2";
const COMPACT_AT_TOKENS = 100_000;
const BLOCKED_TOOLS = new Set(["intercom", "bash", "edit", "write", "multi_edit", "multiedit", "apply_patch", "notebook_edit", "edit_file", "write_file", "quick_edit", "target_edit"]);

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
			if (entry?.[1].trim() && !/^\(empty until sign-off\)$/i.test(entry[1].trim())) return true;
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
	return `You are the visible pi-goals supervisor for ${settings.planPath}. You are a stronger, read-only reviewer. The other Pi session is the implementation worker and keeps the full conversation. You keep the high-level intent from the compacted planning conversation and worker views. The complete plan at ${settings.planPath} is the source of truth; read it directly after every compaction.

Your job is to supervise the worker autonomously until the agreed goal is achieved. Use judgment: identify the missing user-visible result, decide the next useful action, and supervise it through to delivery. Approval records support this work; they are not the outcome. Seek justified confidence, not certainty at any cost. Investigate uncertainty with the cheapest useful check, then decide. Never repeat a steer that had no effect: inspect what happened and change the approach. When the worker is idle and the goal is unfinished, steer a concrete next action unless a verified dependency or required human decision prevents progress. Do not prolong completed work for optional polish.

Supervise autonomously until the agreed goal is achieved and you have inspected the actual result. The worker stopping is not a reason for you to stop. Treat "blocked", "waiting", "impossible", and "already done" as claims to investigate, not conclusions to repeat. Check the evidence and whether the claimed dependency is real. Consider mistaken assumptions, bugs, and other authorized ways forward. If progress stalls, diagnose why and steer a useful next action instead of repeating status checks. Keep independent work moving when it does not depend on the blocker. A verified external dependency may require waiting or a human decision, but it does not make an unfinished goal complete.

Keep authorized work moving. Resolve technical choices within the agreed scope yourself. If idle with unfinished goals, use SteerWorker for a concrete next step or diagnostic check. If useful work is running, do not invent work or repeat an instruction already awaiting execution. Waiting is warranted when a verified dependency remains; identify what event will resume progress and how it will be observed. Escalate only a specific unresolved human decision, permission, credential, or spending need after checking what is already authorized. Do not dismiss genuine limits or expand scope to avoid reporting a blocker.

At each review, give a brief visible recap of how work is tracking against the goal: what the evidence shows and your judgment about the next step. Add perspective rather than repeating status. Distinguish observations from guesses. Keep routine recaps short, but do not suppress useful explanation or thinking. Do not edit files or execute the worker's work.

Ground consequential judgments in verbatim evidence with a source path or link and enough surrounding context to check the interpretation. Keep the observation separate from your inference. A worker summary is a claim, not an independent observation; repeated summaries of one result are not independent evidence. Say what evidence would change your mind. Missing evidence stays unknown until you inspect where it should be.

Check the actual deliverable against the user's goal. Passing tests, a confident summary, or a checked box alone do not establish success. Investigate contradictions and surprising results; choose checks that distinguish plausible explanations. Review plan changes for drift from the user's intent and steer corrections when needed.

When the evidence establishes completion, use ApproveGoal and direct the worker to CompleteGoal. Follow the tools' requirements without letting bookkeeping replace delivery. Once the agreed work is complete, give a short assessment and stop. -- Pi/OpenAI`;
}

export function isVisibleSupervisor(): boolean {
	return process.env.PI_GOALS_ROLE === "supervisor";
}

export function registerVisibleSupervisor(pi: ExtensionAPI): void {
	const settings = config();
	let compacting = false;
	const reminderEvery = Number(process.env.PI_GOALS_SUPERVISOR_REMINDER_TURNS ?? 5);
	if (!Number.isInteger(reminderEvery) || reminderEvery < 1) throw new Error("PI_GOALS_SUPERVISOR_REMINDER_TURNS must be a positive integer.");
	let turnsSinceReminder = reminderEvery;
	let previousPlan = "";
	pi.on("turn_end", async () => { turnsSinceReminder++; });
	pi.on("session_compact", async () => { turnsSinceReminder = reminderEvery; });
	let bootstrapping = false;
	let warnedUnknownUsage = false;
	let modelError: string | null = null;
	const intercom = new GoalIntercom(pi);
	const models = new RoleModels(pi);
	intercom.onView = (view) => pi.sendUserMessage(view.text, { deliverAs: "followUp" });

	const bootstrap = async (ctx: ExtensionContext): Promise<void> => {
		if (bootstrapping || intercom.ended) return;
		const entries = ctx.sessionManager.getEntries();
		bootstrapping = true;
		try {
			const active = pi.getActiveTools();
			pi.setActiveTools(active.filter((tool) => !BLOCKED_TOOLS.has(tool.toLowerCase())));
			const blocked = pi.getActiveTools().filter((tool) => BLOCKED_TOOLS.has(tool.toLowerCase()));
			if (blocked.length) throw new Error(`Could not remove supervisor writing or messaging tools: ${blocked.join(", ")}`);
			if (!entries.some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === BOOTSTRAPPED)) {
				pi.appendEntry(BOOTSTRAPPED, { version: 2, workerSessionId: settings.workerSessionId, planPath: settings.planPath });
			}
			intercom.markReady();
		} catch (error) {
			ctx.ui.notify(`Supervisor startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally { bootstrapping = false; }
	};

	const bootstrapAfterInitialCompaction = (ctx: ExtensionContext): void => {
		const tokens = ctx.getContextUsage()?.tokens;
		const resumed = ctx.sessionManager.getEntries().some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === BOOTSTRAPPED);
		if (resumed || (typeof tokens === "number" && tokens < COMPACT_AT_TOKENS)) {
			void bootstrap(ctx);
			return;
		}
		compacting = true;
		ctx.compact({
			customInstructions: `Preserve the user's high-level intent, decisions, unresolved risks, and the supervisor's remit. The canonical plan is ${settings.planPath}; it remains available directly and must not be replaced by this summary.`,
			onComplete: () => {
				compacting = false;
				if (intercom.ended) return;
				ctx.ui.notify("Supervisor planning context compacted before work started.", "info");
				void bootstrap(ctx);
			},
			onError: (error) => {
				compacting = false;
				if (intercom.ended) return;
				ctx.ui.notify(`Supervisor startup compaction failed: ${error.message}`, "error");
			},
		});
	};

	const start = async (ctx: ExtensionContext): Promise<void> => {
		modelError = "Supervisor model restoration is pending.";
		intercom.configure(settings.approvalId, "supervisor", ctx);
		pi.setActiveTools(pi.getActiveTools().filter((tool) => !BLOCKED_TOOLS.has(tool.toLowerCase())));
		try {
			await models.enter("supervisor", ctx, process.env.PI_GOALS_MODEL_EXPLICIT === "1");
			modelError = null;
			setImmediate(() => { if (!intercom.ended) bootstrapAfterInitialCompaction(ctx); });
		} catch (error) {
			modelError = String(error);
			if (!intercom.ended) ctx.ui.notify(`Supervisor paused: ${modelError} Select /model, then /goals reconnect.`, "error");
		}
	};
	pi.on("session_start", async (_event, ctx) => start(ctx));
	pi.registerCommand("goals", {
		description: "Retry supervisor model restoration and readiness: /goals reconnect",
		handler: async (args, ctx) => {
			if (args.trim() !== "reconnect") { ctx.ui.notify("Use /goals reconnect here; manage the plan or restart the pane from the worker session.", "info"); return; }
			if (!ctx.isIdle() || compacting) { ctx.ui.notify("Wait for the supervisor to settle before reconnecting.", "warning"); return; }
			await start(ctx);
		},
	});
	pi.on("tool_call", async (event) => {
		if (BLOCKED_TOOLS.has(event.toolName.toLowerCase())) return { block: true, terminate: true, reason: "Supervisor is read-only; use SteerWorker for the bound worker, not the general intercom tool." };
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		const plan = readFileSync(settings.planPath, "utf8").split(/^## Log\s*$/m)[0].trim();
		const remind = plan !== previousPlan || turnsSinceReminder >= reminderEvery;
		previousPlan = plan;
		if (remind) turnsSinceReminder = 0;
		const reminder = remind ? "\n\nSupervisor role reminder: Supervise autonomously toward the agreed outcome. Use judgment, investigate blockers, keep useful work moving, and inspect the result before accepting completion. A checkbox change is a claim to review, not proof." : "";
		return { systemPrompt: `${ctx.getSystemPrompt()}\n\n${supervisorPrompt(settings)}\n\nCurrent agreed plan (reread for every review):\n${plan}\n\nJudge progress against this outcome and its discriminators. A completed artifact or task is not completion unless it satisfies the agreed goal.${reminder}` };
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (compacting) return;
		const usage = ctx.getContextUsage();
		if (!usage && !warnedUnknownUsage) {
			warnedUnknownUsage = true;
			ctx.ui.notify("Supervisor context usage unavailable; the custom 100k compaction trigger cannot be checked. Pi's default auto-compaction is unchanged.", "warning");
		}
		// Pi reports tokens:null after compaction until a fresh assistant usage sample.
		if (typeof usage?.tokens !== "number" || usage.tokens < COMPACT_AT_TOKENS) return;
		compacting = true;
		ctx.compact({
			customInstructions: `Keep the user's high-level intent, current plan state, unresolved risks, approval decisions, and the supervisor's own concise findings. Remove old worker views and implementation detail. The canonical plan remains ${settings.planPath}.`,
			onComplete: () => {
				compacting = false;
				if (intercom.ended) return;
				ctx.ui.notify("Supervisor context compacted at 100k tokens.", "info");
			},
			onError: (error) => {
				compacting = false;
				if (intercom.ended) return;
				ctx.ui.notify(`Supervisor compaction failed: ${error.message}`, "error");
			},
		});
	});

	pi.registerTool({
		name: "SteerWorker",
		label: "Steer worker",
		executionMode: "sequential",
		description: "Write one concrete instruction for the implementation worker.",
		parameters: Type.Object({ instruction: Type.String({ description: "Concrete next instruction for the worker." }) }),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", "Supervisor → worker")}\n${args.instruction ?? ""}`, 0, 0);
		},
		async execute(_id, params) {
			if (modelError) return result(`Supervisor paused: ${modelError} Use /model, then /goals reconnect.`, true);
			const instruction = params.instruction.trim();
			if (!instruction) return result("A worker instruction cannot be empty.", true);
			const id = intercom.steer(instruction);
			return result(`Worker instruction ${id} sent through pi-intercom. Receipt and execution are not confirmed by this result.`);
		},
	});

	pi.registerTool({
		name: "ApproveGoal",
		label: "Approve goal",
		executionMode: "sequential",
		description: "Record approval after inspecting the current goal, repository, evidence, and a saved nonempty verification-output file, with a stopped worker view and no active work. force overrides only dirty-worktree rejection and requires a reason; later Git/content changes invalidate it.",
		parameters: Type.Object({
			goal: Type.String({ description: "Exact text after goal: in the plan." }),
			verifyOutputPath: Type.String({ description: "Nonempty repository-relative file containing the verification output you inspected." }),
			force: Type.Optional(Type.Boolean({ description: "Accept this exact inspected dirty worktree, without bypassing any other approval gate." })),
			reason: Type.Optional(Type.String({ description: "Required with force:true. Why accepting these inspected worktree changes is justified." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (modelError) return result(`Supervisor paused: ${modelError} Use /model, then /goals reconnect.`, true);
			const force = params.force === true;
			const reason = params.reason?.trim();
			if (force && !reason) return result("Cannot force approval without an explicit nonempty reason for accepting this worktree state.", true);
			const view = latestWorkerView(ctx);
			const newest = intercom.latestView;
			if (!intercom.connected) return result("Cannot approve: worker supervision is disconnected or not ready. Restore the existing connection before review.", true);
			if (!newest) return result("Cannot approve: no worker view has arrived.", true);
			if (view !== newest.text) return result("Cannot approve this older worker view. A newer view is queued for you; finish this response to receive it. Do not ask the worker to generate another handoff merely to refresh this review.", true);
			if (!view?.startsWith("The worker stopped.")) return result("Cannot approve without a current stopped-worker view.", true);
			if (!newest.backgroundQuiet) return result("Cannot approve while tracked background work is active or unknown.", true);
			const pendingTool = view.match(/^tool calls with no result: (?!none$)(.+)$/m);
			const pendingChild = view.match(/^child pi processes still running: (?!none$)(.+)$/m);
			if (pendingTool || pendingChild) return result(`Cannot approve while work is active: ${(pendingTool ?? pendingChild)![1]}`, true);
			let plan: string;
			let repository: ReturnType<typeof repositoryState>;
			try {
				plan = readFileSync(settings.planPath, "utf8");
				repository = repositoryState(ctx.cwd, force);
			} catch (error) {
				return result(`Cannot inspect approval inputs: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			if (!repository.cleanWorktree && !force) return result("Cannot approve with a dirty worktree. Commit only the worker's changes, or inspect preserved changes and use force:true with a reason. Do not commit unrelated changes to satisfy this gate.", true);
			const block = goalBlock(plan, params.goal);
			if (!block) return result(`Cannot approve: no unique open goal matches "${params.goal}".`, true);
			if (!hasEvidenceEntry(block)) return result("Cannot approve without a nonblank evidence entry in the goal block.", true);
			const verifiedOutput = verifyOutputPath(repository.repoRoot, params.verifyOutputPath);
			if (!verifiedOutput) return result("Cannot approve without a nonempty repository-relative verification-output file.", true);
			const path = approvalPath(ctx.cwd, settings.ownerSessionId, params.goal);
			writeApproval(path, {
				version: 3, verdict: "accept", approvalId: settings.approvalId, goal: params.goal, planPath: settings.planPath,
				goalBlockHash: hashGoalBlock(block), repoRoot: repository.repoRoot, head: repository.head, tree: repository.tree,
				cleanWorktree: repository.cleanWorktree, ...(force ? { force: { reason: reason!, worktree: repository.worktree! } } : {}), inspected: { plan: true, repository: true, evidence: true, verifyOutput: true }, verifyOutputPath: verifiedOutput,
				supervisor: { sessionId: ctx.sessionManager.getSessionId(), runId: null }, timestamp: new Date().toISOString(),
			});
			return result(`Approval recorded for "${params.goal}".${force ? ` Forced worktree acceptance: ${reason}. Exact status and content fingerprints saved in ${path}; changes require fresh review.` : ""} Now steer the worker to call CompleteGoal.`);
		},
	});
}
