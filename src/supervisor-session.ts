import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { approvalPath, goalBlock, hashGoalBlock, repositoryState, verifyOutputPath, writeApproval } from "./approval.js";
import { readyMailbox, workerViewsAfter, writeWorkerSteer } from "./mailbox.js";

const BOOTSTRAPPED = "pi-goals-visible-supervisor-v2";
const INITIAL_COMPACT_AT_TOKENS = 20_000;
const COMPACT_AT_TOKENS = 100_000;
const WRITER_TOOLS = new Set(["bash", "edit", "write", "multi_edit", "multiedit", "apply_patch", "notebook_edit", "edit_file", "write_file", "quick_edit", "target_edit"]);

interface SupervisorConfig {
	workerSessionId: string;
	ownerSessionId: string;
	planPath: string;
	approvalId: string;
	mailboxPath: string;
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
		mailboxPath: resolve(requiredEnv("PI_GOALS_MAILBOX_PATH")),
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
	return `You are the visible pi-goals supervisor for ${settings.planPath}. You are a stronger, read-only reviewer. The other Pi session is the implementation worker and keeps the full conversation. You keep the high-level intent from the compacted planning conversation and worker views. The complete plan at ${settings.planPath} is the source of truth; read it directly after every compaction.

At each review, give a brief visible recap of how work is tracking against the goal: what the evidence shows and your judgment about the next step. Add perspective rather than repeating the worker's account. Distinguish observations from guesses. Read more evidence when needed; keep routine recaps short, but do not suppress useful explanation or thinking. Use SteerWorker when a correction or continuation is warranted. If the worker is making useful progress, say why and let it continue; do not invent work or repeat an instruction already awaiting execution. When idle with unfinished goals, give a concrete next step unless blocked on the human. Do not edit files. For each open goal, inspect its exact plan block, repository state, cited evidence, and a saved nonempty verification-output file. A stopped view means Pi is idle, not that background jobs have finished. Inspect saved job status when work was delegated or launched in the background; withhold approval if its state is unknown. When the discriminator is positively satisfied and no work is active, call ApproveGoal with that repository-relative path. Then call SteerWorker and tell the worker to call CompleteGoal with the exact goal text. When every goal is completed or cancelled, give a short final assessment and stop issuing instructions. -- Pi/OpenAI`;
}

export function isVisibleSupervisor(): boolean {
	return process.env.PI_GOALS_ROLE === "supervisor";
}

export function registerVisibleSupervisor(pi: ExtensionAPI): void {
	const settings = config();
	let compacting = false;
	let bootstrapping = false;
	let deliveredView = 0;
	let viewTimer: ReturnType<typeof setInterval> | undefined;

	const deliverWorkerViews = (): void => {
		const view = workerViewsAfter(settings.mailboxPath, deliveredView).at(-1);
		if (view) {
			if (view.reason !== "started") pi.sendUserMessage(view.text, { deliverAs: "followUp" });
			deliveredView = view.sequence;
		}
	};

	const bootstrap = async (ctx: ExtensionContext): Promise<void> => {
		if (bootstrapping) return;
		const entries = ctx.sessionManager.getEntries();
		bootstrapping = true;
		try {
			const active = pi.getActiveTools();
			pi.setActiveTools(active.filter((tool) => !WRITER_TOOLS.has(tool.toLowerCase())));
			const writers = pi.getActiveTools().filter((tool) => WRITER_TOOLS.has(tool.toLowerCase()));
			if (writers.length) throw new Error(`Could not remove supervisor writing tools: ${writers.join(", ")}`);
			if (!entries.some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === BOOTSTRAPPED)) {
				pi.appendEntry(BOOTSTRAPPED, { version: 2, workerSessionId: settings.workerSessionId, planPath: settings.planPath });
			}
			for (const entry of entries) {
				const message = (entry as { message?: { role?: string; content?: unknown } }).message;
				if (message?.role !== "user" || !Array.isArray(message.content)) continue;
				for (const part of message.content) {
					if (part.type !== "text" || !part.text.startsWith("The worker ")) continue;
					const sequence = /^worker view sequence: (\d+)$/m.exec(part.text);
					if (sequence) deliveredView = Math.max(deliveredView, Number(sequence[1]));
				}
			}
			readyMailbox(settings.mailboxPath);
			viewTimer = setInterval(deliverWorkerViews, 1_000);
			deliverWorkerViews();
		} catch (error) {
			ctx.ui.notify(`Supervisor startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	const bootstrapAfterInitialCompaction = (ctx: ExtensionContext): void => {
		const tokens = ctx.getContextUsage()?.tokens;
		const resumed = ctx.sessionManager.getEntries().some((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === BOOTSTRAPPED);
		if (resumed || (typeof tokens === "number" && tokens <= INITIAL_COMPACT_AT_TOKENS)) {
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
		rmSync(join(settings.mailboxPath, "ready.json"), { force: true });
		pi.setActiveTools(pi.getActiveTools().filter((tool) => !WRITER_TOOLS.has(tool.toLowerCase())));
		setImmediate(() => { bootstrapAfterInitialCompaction(ctx); });
	});
	pi.on("session_shutdown", async () => {
		if (viewTimer) clearInterval(viewTimer);
		rmSync(join(settings.mailboxPath, "ready.json"), { force: true });
	});
	pi.on("before_agent_start", async (_event, ctx) => ({ systemPrompt: `${ctx.getSystemPrompt()}\n\n${supervisorPrompt(settings)}` }));
	pi.on("agent_settled", async (_event, ctx) => {
		if (compacting || (ctx.getContextUsage()?.tokens ?? 0) < COMPACT_AT_TOKENS) return;
		compacting = true;
		ctx.compact({
			customInstructions: `Keep the user's high-level intent, current plan state, unresolved risks, approval decisions, and the supervisor's own concise findings. Remove old worker views and implementation detail. The canonical plan remains ${settings.planPath}.`,
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
		name: "SteerWorker",
		label: "Steer worker",
		executionMode: "sequential",
		description: "Write one concrete instruction for the implementation worker.",
		parameters: Type.Object({ instruction: Type.String({ description: "Concrete next instruction for the worker." }) }),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", "Supervisor → worker")}\n${args.instruction ?? ""}`, 0, 0);
		},
		async execute(_id, params) {
			const instruction = params.instruction.trim();
			if (!instruction) return result("A worker instruction cannot be empty.", true);
			const steer = writeWorkerSteer(settings.mailboxPath, instruction);
			return result(`Worker instruction ${steer.sequence} recorded. Worker receipt and execution are not confirmed.`);
		},
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
			const newest = workerViewsAfter(settings.mailboxPath, 0).at(-1);
			if (!newest || view !== newest.text) return result("Cannot approve without inspecting the latest worker view.", true);
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
				version: 3, verdict: "accept", approvalId: settings.approvalId, goal: params.goal, planPath: settings.planPath,
				goalBlockHash: hashGoalBlock(block), repoRoot: repository.repoRoot, head: repository.head, tree: repository.tree,
				cleanWorktree: true, inspected: { plan: true, repository: true, evidence: true, verifyOutput: true }, verifyOutputPath: verifiedOutput,
				supervisor: { sessionId: ctx.sessionManager.getSessionId(), runId: null }, timestamp: new Date().toISOString(),
			});
			return result(`Approval recorded for "${params.goal}". Now steer the worker to call CompleteGoal.`);
		},
	});
}
