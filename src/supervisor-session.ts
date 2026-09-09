import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { approvalPath, goalBlock, hashGoalBlock, repositoryState, verifyOutputPath, writeApproval } from "./approval.js";
import { goalCommandCompletions } from "./command-help.js";
import { GoalIntercom } from "./intercom.js";
import { planViews } from "./plan-view.js";
import { approveGoalDescription, approveGoalParameters, goalApprovalRecorded, steerWorkerDescription, steerWorkerInstructionDescription, supervisorCompaction, supervisorOrientation, supervisorReviewContext, workerInstructionQueued, workerInstructionSent } from "./prompts.js";
import { RoleModels } from "./role-models.js";

const BOOTSTRAPPED = "pi-goals-visible-supervisor-v2";
const COMPACT_AT_TOKENS = 100_000;

const ROLE_STATE = "pi-goals-supervisor-binding";

export interface SupervisorConfig {
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

export function isVisibleSupervisor(): boolean {
	return process.env.PI_GOALS_ROLE === "supervisor";
}

export function restoredSupervisor(entries: readonly { type: string; customType?: string; data?: unknown }[]): SupervisorConfig | undefined {
	const savedEntry = entries.filter(entry => entry.type === "custom" && entry.customType === ROLE_STATE).at(-1);
	if (savedEntry) {
		const saved = savedEntry.data as SupervisorConfig | undefined;
		if (!saved || ![saved.workerSessionId, saved.ownerSessionId, saved.planPath, saved.approvalId].every(value => typeof value === "string" && value.trim())) throw new Error("Saved supervisor binding is incomplete. Restore its original session metadata before resuming; worker mode was not enabled.");
		return saved;
	}
	const legacyEntry = entries.filter(entry => entry.type === "custom" && entry.customType === BOOTSTRAPPED).at(-1);
	if (!legacyEntry) return;
	const legacy = legacyEntry.data as Partial<SupervisorConfig> | undefined;
	const binding = entries.filter(entry => entry.type === "custom" && entry.customType === "pi-goals-state").map(entry => entry.data as { approvalId?: string }).filter(state => state?.approvalId).at(-1)?.approvalId;
	if (!legacy || ![legacy.workerSessionId, legacy.planPath, binding].every(value => typeof value === "string" && value.trim())) throw new Error("Saved supervisor role has no complete binding. Restore its original session metadata before resuming. Worker mode was not enabled.");
	return { workerSessionId: legacy.workerSessionId!, ownerSessionId: legacy.workerSessionId!, planPath: legacy.planPath!, approvalId: binding! };
}

export function registerVisibleSupervisor(pi: ExtensionAPI, restored?: SupervisorConfig): void {
	const settings = restored ?? config();
	let compacting = false;
	let startupTimer: ReturnType<typeof setTimeout> | undefined;
	let startupChecks = 0;
	let statusContext: ExtensionContext | undefined;
	pi.on("session_shutdown", async () => { if (startupTimer) clearTimeout(startupTimer); statusContext?.ui.setStatus("pi-goals", undefined); });
	let repeatFullPrompt = true;
	pi.on("session_compact", async () => { repeatFullPrompt = true; });
	let bootstrapping = false;
	let warnedUnknownUsage = false;
	let modelError: string | null = null;
	const intercom = new GoalIntercom(pi);
	const models = new RoleModels(pi);
	const updateStatus = (ctx: ExtensionContext) => {
		const label = modelError || intercom.readinessFailure ? "supervisor · paused" : intercom.connected ? "supervising" : "supervisor · starting/reconnecting";
		ctx.ui.setStatus("pi-goals", label);
	};
	intercom.onConnectionChange = updateStatus;
	let lastAssistantError: string | undefined;
	pi.on("agent_end", async event => {
		const last = event.messages.filter(message => message.role === "assistant").at(-1);
		lastAssistantError = last?.stopReason === "error" ? last.errorMessage ?? "Supervisor model returned an error without a reason." : undefined;
	});
	intercom.onView = (view) => pi.sendUserMessage(view.text, { deliverAs: "followUp" });
	pi.on("session_compact_failed", async event => {
		if (!startupTimer) return;
		clearTimeout(startupTimer);
		startupTimer = undefined;
		intercom.failReady(`${event.aborted ? "Supervisor compaction was cancelled" : event.errorMessage ?? "Supervisor compaction failed"}. Use /goals supervise in its session to retry.`);
	});

	const bootstrap = async (ctx: ExtensionContext): Promise<void> => {
		if (bootstrapping || intercom.ended) return;
		const entries = ctx.sessionManager.getEntries();
		bootstrapping = true;
		try {
			if (!entries.some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === BOOTSTRAPPED)) {
				pi.appendEntry(BOOTSTRAPPED, { version: 2, workerSessionId: settings.workerSessionId, planPath: settings.planPath });
			}
			intercom.markReady();
		} catch (error) {
			ctx.ui.notify(`Supervisor startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally { bootstrapping = false; }
	};

	const bootstrapAfterInitialCompaction = (ctx: ExtensionContext): void => {
		if (intercom.ended) return;
		// A reload does not terminate Pi's in-flight compaction. Never start a competing one.
		if (!ctx.isIdle()) {
			if (++startupChecks > 300) { intercom.failReady("Supervisor startup is still busy. Inspect its session, then use /goals supervise to retry."); return; }
			startupTimer = setTimeout(() => bootstrapAfterInitialCompaction(ctx), 1000);
			return;
		}
		startupTimer = undefined;
		const tokens = ctx.getContextUsage()?.tokens;
		const resumed = ctx.sessionManager.getEntries().some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === BOOTSTRAPPED);
		const latestContext = ctx.sessionManager.getEntries().filter(entry => entry.type === "message" || entry.type === "compaction").at(-1);
		if (resumed || latestContext?.type === "compaction" || (typeof tokens === "number" && tokens < COMPACT_AT_TOKENS)) {
			void bootstrap(ctx);
			return;
		}
		compacting = true;
		ctx.compact({
			customInstructions: supervisorCompaction(settings.planPath, true),
			onComplete: () => {
				compacting = false;
				if (intercom.ended) return;
				ctx.ui.notify("Supervisor planning context compacted before work started.", "info");
				void bootstrap(ctx);
			},
			onError: (error) => {
				compacting = false;
				if (intercom.ended) return;
				if (/^(Already compacted|Nothing to compact)/.test(error.message)) { void bootstrap(ctx); return; }
				intercom.failReady(`Supervisor startup compaction failed: ${error.message}. Use /goals reconnect in the supervisor pane.`);
				ctx.ui.notify(`Supervisor startup compaction failed: ${error.message}`, "error");
			},
		});
	};

	const start = async (ctx: ExtensionContext): Promise<void> => {
		statusContext = ctx;
		lastAssistantError = undefined;
		if (startupTimer) clearTimeout(startupTimer);
		startupTimer = undefined;
		startupChecks = 0;
		modelError = "Supervisor model restoration is pending.";
		updateStatus(ctx);
		if (!ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === ROLE_STATE)) pi.appendEntry(ROLE_STATE, settings);
		intercom.configure(settings.approvalId, "supervisor", ctx);
		try {
			await models.enter("supervisor", ctx, process.env.PI_GOALS_MODEL_EXPLICIT === "1");
			modelError = null;
			updateStatus(ctx);
			setImmediate(() => { if (!intercom.ended) bootstrapAfterInitialCompaction(ctx); });
		} catch (error) {
			modelError = String(error);
			if (!intercom.ended) {
				intercom.failReady(`Supervisor paused: ${modelError}. Select /model in its session, then /goals supervise.`);
				ctx.ui.notify(`Supervisor paused: ${modelError} Select /model, then /goals reconnect.`, "error");
			}
		}
	};
	pi.on("session_start", async (_event, ctx) => start(ctx));
	pi.registerCommand("goals", {
		description: "Reconnect this saved supervisor role and pairing: /goals supervise (or reconnect)",
		getArgumentCompletions: prefix => goalCommandCompletions(prefix, "supervisor"),
		handler: async (args, ctx) => {
			if (!["reconnect", "supervise"].includes(args.trim())) { ctx.ui.notify("This is the supervisor session. Use /goals supervise here; /goals work and /goals noplan belong to the worker. No role or plan was changed.", "info"); return; }
			if (!ctx.isIdle() || compacting) { ctx.ui.notify("Wait for the supervisor to settle before reconnecting.", "warning"); return; }
			await start(ctx);
		},
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		const plan = planViews(readFileSync(settings.planPath, "utf8"));
		const message = repeatFullPrompt ? { customType: "pi-goals-supervisor-role", content: supervisorOrientation(settings.planPath, plan.long), display: true } : undefined;
		repeatFullPrompt = false;
		return {
			systemPrompt: `${ctx.getSystemPrompt()}\n\n${supervisorReviewContext(settings.planPath, plan.short)}`,
			...(message ? { message } : {}),
		};
	});
	pi.on("agent_settled", async (_event, ctx) => {
		// Settled is after Pi's automatic retries/compaction, unlike agent_end.
		if (lastAssistantError) {
			intercom.failReady(`Supervisor model failed after Pi recovery: ${lastAssistantError}`);
			lastAssistantError = undefined;
			return;
		}
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
			customInstructions: supervisorCompaction(settings.planPath, false),
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
		description: steerWorkerDescription,
		parameters: Type.Object({ instruction: Type.String({ description: steerWorkerInstructionDescription }) }),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", "Supervisor → worker")}\n${args.instruction ?? ""}`, 0, 0);
		},
		async execute(_id, params) {
			if (modelError) return result(`Supervisor paused: ${modelError} Use /model, then /goals reconnect.`, true);
			const instruction = params.instruction.trim();
			if (!instruction) return result("A worker instruction cannot be empty.", true);
			const delivery = intercom.steer(instruction);
			return result(delivery.queued ? workerInstructionQueued(delivery.id) : workerInstructionSent(delivery.id));
		},
	});

	pi.registerTool({
		name: "ApproveGoal",
		label: "Approve goal",
		executionMode: "sequential",
		description: approveGoalDescription,
		parameters: Type.Object({
			goal: Type.String({ description: approveGoalParameters.goal }),
			verifyOutputPath: Type.String({ description: approveGoalParameters.verifyOutputPath }),
			force: Type.Optional(Type.Boolean({ description: approveGoalParameters.force })),
			reason: Type.Optional(Type.String({ description: approveGoalParameters.reason })),
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
			if (newest.reason === "started") return result("Cannot approve while the worker is starting or running. Wait for its stopped-worker view.", true);
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
			return result(goalApprovalRecorded(params.goal, force ? { reason: reason!, path } : undefined));
		},
	});
}
