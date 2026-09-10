/**
 * PI: pi-goals owns one versioned plan per session. After Ready, the main session implements the
 * plan while a compacted, visible fork supervises it through pi-intercom.
 *
 * Each /goals call makes `.pi/plan/<session_id>-vN.md`. The selected version survives resume and
 * compaction. Old plans stay on disk but inactive. A session with no selected plan has no widget,
 * supervision, or CompleteGoal sign-off.
 *
 * TypeScript reads only goal checkbox lines for the widget. Models read the plan as prose. The
 * worker edits the project and records evidence. The supervisor inspects it and writes a private
 * approval checkpoint.
 *
 * -- Pi/Codex
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approvalMatches, approvalPath, goalBlock, hashGoalBlock, readApproval, repositoryState } from "./approval.js";
import { backgroundState } from "./background.js";
import { goalCommandCompletions } from "./command-help.js";
import { closeSupervisorPane, openSupervisorPane } from "./herdr.js";
import { GoalIntercom } from "./intercom.js";
import { FOLD_LINE, foldPlan, GOAL_LINE } from "./plan.js";
import { completeGoalDescription, completeGoalParamDescription, planDrafting, planningState, resync, supervisorPlanReview, workerCompaction } from "./prompts.js";
import { RoleModels } from "./role-models.js";
import { COMPACT_AT_TOKENS, isVisibleSupervisor, registerVisibleSupervisor, restoredSupervisor } from "./supervisor-session.js";
import { workerView } from "./worker-view.js";

export { foldPlan } from "./plan.js";

const STATE = "pi-goals-state";
const STATUS_KEY = "pi-goals";
const WIDGET_KEY = "pi-goals-widget";
const PLANNING_CONTEXT = "pi-goals-planning-context";
const PLAN_DIR = ".pi/plan";
// For static text (the /goals description) where there is no ctx to resolve the session id.
const PLAN_SHAPE = `${PLAN_DIR}/<session_id>-vN.md`;
// Plan mode blocks edit/write except for its plan file. bash remains available for read-only inspection. -- Pi/Codex
const PLAN_MODE_BLOCKED_TOOLS = ["edit", "write"];

// An indented checkbox line that isn't a goal: a subtask. Only the widget reads these, so the human
// sees the next action and not just the goal -- this file IS the task list.
const SUBTASK_LINE = /^\s+(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*(.*)$/;
type GoalStatus = "open" | "active" | "done" | "cancelled";
const CHAR_TO_STATUS: Record<string, GoalStatus> = { " ": "open", "/": "active", x: "done", "-": "cancelled" };
const STATUS_TO_CHAR: Record<GoalStatus, string> = { open: " ", active: "/", done: "x", cancelled: "-" };
const goalKey = (subject: string) => subject.trim().toLowerCase();

function scanGoals(plan: string): Array<{ status: GoalStatus; subject: string; line: number }> {
	const goals: Array<{ status: GoalStatus; subject: string; line: number }> = [];
	foldPlan(plan).split("\n").forEach((line, i) => {
		const m = GOAL_LINE.exec(line);
		if (m) goals.push({ status: CHAR_TO_STATUS[m[1].toLowerCase()] ?? "open", subject: m[2].trim(), line: i });
	});
	return goals;
}

/** Open subtasks under the goal on line `goalLine`, up to the next goal line. */
export function openSubtasks(plan: string, goalLine: number): string[] {
	const lines = foldPlan(plan).split("\n");
	const out: string[] = [];
	for (let i = goalLine + 1; i < lines.length; i++) {
		if (GOAL_LINE.test(lines[i])) break;
		const m = SUBTASK_LINE.exec(lines[i]);
		if (m && (m[1] === " " || m[1] === "/")) out.push(m[2].trim());
	}
	return out;
}

export function nextPlanVersion(planNames: string[], sessionId: string): number {
	const prefix = `${sessionId}-v`;
	const versions = planNames.flatMap((name) => {
		if (!name.startsWith(prefix) || !name.endsWith(".md")) return [];
		const version = Number(name.slice(prefix.length, -".md".length));
		return Number.isInteger(version) && version > 0 ? [version] : [];
	});
	return Math.max(0, ...versions) + 1;
}

type Phase = "planning" | "working" | null;

// Only launch/readiness failures authorize fallback, not local model, plan or repository errors.
class SupervisorFailure extends Error {}

export function isMainSession(isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1"): boolean {
	return !isSubagentChild && !isVisibleSupervisor();
}

interface PlanState {
	phase: Phase;
	mode: "supervised" | "solo";
	soloReason: string | null;
	supervisorModel: string | null;
	supervisorPaneId: string | null;
	approvalId: string | null;
	planVersion: number | null;
	latestDirection: string;
	signedOffGoals: string[];
	previousPlan: string | null;
}

export default function piGoalsExtension(pi: ExtensionAPI): void {
	let initialized = false;
	pi.on("session_start", async (_event, ctx) => {
		if (initialized) return;
		initialized = true;
		const saved = restoredSupervisor(ctx.sessionManager.getEntries());
		if (saved || isVisibleSupervisor()) registerVisibleSupervisor(pi, saved);
		else if (isMainSession()) registerWorker(pi);
		// Pi's dispatcher iterates its live handler list, including those just registered.
	});
}

export function registerWorker(pi: ExtensionAPI): void {
	const intercom = new GoalIntercom(pi);
	const models = new RoleModels(pi);
	intercom.onSteer = (instruction) => {
		if (state.phase !== "working" || state.mode === "solo" || modelError) throw new Error("Worker is paused or its plan is not active; instruction not delivered. Use /goals reconnect after selecting an available model.");
		pi.sendUserMessage(`[supervisor] ${instruction}`, { deliverAs: "steer" });
	};
	let state: PlanState = {
		phase: null,
		mode: "supervised",
		soloReason: null,
		supervisorModel: null,
		supervisorPaneId: null,
		approvalId: null,
		planVersion: null,
		latestDirection: "",
		signedOffGoals: [],
		previousPlan: null,
	};
	let modelError: string | null = null;
	let lastAssistantError: string | undefined;
	let readyAttempt: object | undefined;
	let wasConnected = false;
	let recoveryAttempt: object | undefined;
	let commandAttempt: object | undefined;
	let recoveryCommand: object | undefined;
	intercom.onConnectionChange = (ctx) => {
		const connected = intercom.connected;
		const rejoined = connected && !wasConnected;
		wasConnected = connected;
		updateWidget(ctx);
		if (!connected) recoverSupervisor(ctx);
		// Ready publishes its own first view. Subsequent rejoins need a new ID even if the old view was accepted.
		if (rejoined && !readyAttempt && state.phase === "working" && state.mode === "supervised" && !modelError) {
			void publishWorkerView(ctx, "settled").catch(error => { if (!intercom.ended) ctx.ui.notify(`Recovery view failed: ${String(error)}`, "error"); });
		}
	};
	let planningContextPending = false;
	let resyncReason: string | null = "New session.";

	const planRel = (ctx: ExtensionContext) => (state.planVersion === null ? PLAN_SHAPE : `${PLAN_DIR}/${ctx.sessionManager.getSessionId()}-v${state.planVersion}.md`);
	const planPath = (ctx: ExtensionContext) => {
		if (state.planVersion === null) throw new Error("No active plan version.");
		return join(ctx.cwd, planRel(ctx));
	};
	const readPlan = (ctx: ExtensionContext): string => (state.planVersion !== null && existsSync(planPath(ctx)) ? readFileSync(planPath(ctx), "utf-8") : "");
	const writePlan = (ctx: ExtensionContext, content: string): void => {
		mkdirSync(join(ctx.cwd, PLAN_DIR), { recursive: true });
		writeFileSync(planPath(ctx), content);
	};
	const nextVersion = (ctx: ExtensionContext): number =>
		nextPlanVersion(existsSync(join(ctx.cwd, PLAN_DIR)) ? readdirSync(join(ctx.cwd, PLAN_DIR)) : [], ctx.sessionManager.getSessionId());

	function persist(): void {
		pi.appendEntry<PlanState>(STATE, state);
	}

	// Only CompleteGoal adds sign-off; direct edits remain claims for supervisor judgment.
	function refreshSignoffs(ctx: ExtensionContext): void {
		if (state.phase !== "working") return;
		const goals = scanGoals(readPlan(ctx));
		const signedOffGoals = state.signedOffGoals.filter(subject => {
			const matches = goals.filter(goal => goalKey(goal.subject) === subject);
			return matches.length === 1 && matches[0].status === "done";
		});
		if (signedOffGoals.length !== state.signedOffGoals.length) {
			state = { ...state, signedOffGoals };
			persist();
		}
	}

	function planReview(plan: string): string {
		const goals = scanGoals(plan);
		const previous = scanGoals(state.previousPlan ?? "");
		const changes = goals.flatMap(goal => {
			const old = previous.find(prior => goalKey(prior.subject) === goalKey(goal.subject));
			return old?.status === goal.status ? [] : [`${goal.subject}: ${old ? `[${STATUS_TO_CHAR[old.status]}]` : "not previously observed"} -> [${STATUS_TO_CHAR[goal.status]}]${goal.status === "done" ? state.signedOffGoals.includes(goalKey(goal.subject)) ? "; CompleteGoal sign-off recorded" : "; manual completion claim, no CompleteGoal sign-off recorded" : ""}`];
		});
		const claims = goals.filter(goal => goal.status === "done" && !state.signedOffGoals.includes(goalKey(goal.subject)));
		return supervisorPlanReview(claims.map(goal => goal.subject), changes, planDiff(state.previousPlan ?? "", plan));
	}

	function planIsComplete(ctx: ExtensionContext): boolean {
		const goals = scanGoals(readPlan(ctx));
		return goals.length > 0 && goals.every(goal => goal.status === "cancelled" || (goal.status === "done" && state.signedOffGoals.includes(goalKey(goal.subject))));
	}

	function enterSolo(ctx: ExtensionContext, reason: string): void {
		if (state.phase !== "working" || modelError || intercom.ended) return;
		recoveryAttempt = undefined;
		state = { ...state, mode: "solo", soloReason: reason, approvalId: null };
		persist();
		stopWorkerTimers();
		intercom.detach(`Worker entered solo mode; this pairing is detached. ${reason} Restore supervision with /goals restart in the worker session.`);
		const message = `UNSUPERVISED WORKER: ${reason} Continuing in solo mode with the same approved plan (${planRel(ctx)}) and evidence preserved. Supervisor sign-off is unavailable; do not call CompleteGoal or claim supervised completion. Continue useful implementation and save verification evidence. Use /goals restart to restore supervision.`;
		ctx.ui.notify(message, "warning");
		pi.sendMessage({ customType: "pi-goals-mode", content: message, display: true });
		updateWidget(ctx);
		pi.sendUserMessage(message, { deliverAs: "followUp" });
	}

	// Reuse the existing five-minute readiness window; an explicit peer failure ends it early.
	function recoverSupervisor(ctx: ExtensionContext): void {
		if (recoveryAttempt || recoveryCommand || readyAttempt || state.phase !== "working" || state.mode !== "supervised" || planIsComplete(ctx) || modelError || !intercom.bound || intercom.connected) return;
		const attempt = {};
		recoveryAttempt = attempt;
		const binding = state.approvalId;
		ctx.ui.notify("Supervisor connection is not ready. Goal work is paused; the plan is preserved. Waiting up to five minutes for the existing supervisor to recover. An explicit failure or timeout will switch to unsupervised work with a visible reason.", "warning");
		void intercom.waitReady().catch(error => {
			if (recoveryAttempt === attempt && state.approvalId === binding && state.phase === "working" && state.mode === "supervised" && !modelError && !intercom.ended) enterSolo(ctx, `Supervisor recovery failed: ${String(error)}`);
		}).finally(() => {
			if (recoveryAttempt !== attempt) return;
			recoveryAttempt = undefined;
			if (!intercom.ended && !intercom.connected) recoverSupervisor(ctx);
		});
	}

	function pauseReason(ctx: ExtensionContext): string | null {
		if (!state.phase) return null;
		if (modelError) return `${modelError} Select /model, then run /goals reconnect.`;
		if (state.phase === "working" && state.mode === "supervised" && !planIsComplete(ctx) && !intercom.connected) return intercom.peerPresent
			? "Supervisor is present but not ready. Inspect its pane for startup/compaction or model errors; recover with /model then /goals reconnect in the supervisor pane if needed."
			: "Supervisor disconnected. Run /goals reconnect, or /goals restart to replace its tracked pane without discarding the plan.";
		return null;
	}

	async function restoreModel(role: "planning" | "worker", ctx: ExtensionContext): Promise<void> {
		lastAssistantError = undefined;
		modelError = `${role} model restoration is pending.`;
		intercom.markNotReady();
		try {
			await models.enter(role, ctx);
			modelError = null;
		} catch (error) {
			modelError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	/** Compact the agreed planning conversation once, before the supervisor forks it. */
	function compactApprovedWorker(ctx: ExtensionContext): Promise<void> {
		const tokens = ctx.getContextUsage()?.tokens;
		if (typeof tokens === "number" && tokens < COMPACT_AT_TOKENS) return Promise.resolve();
		return new Promise((resolve, reject) => {
			ctx.compact({
				customInstructions: workerCompaction(planPath(ctx)),
				onComplete: () => resolve(),
				onError: error => {
					// A small already-compacted session needs no second compacted fork.
					if (/^(Already compacted|Nothing to compact)/.test(error.message)) resolve();
					else reject(error);
				},
			});
		});
	}

	function beginReview(ctx: ExtensionContext): void {
		for (const goal of scanGoals(readPlan(ctx))) {
			rmSync(approvalPath(ctx.cwd, ctx.sessionManager.getSessionId(), goal.subject), { force: true });
		}
		const approvalId = randomUUID();
		state = { ...state, approvalId };
		intercom.configure(approvalId, "worker", ctx, false);
		persist();
	}

	function repositoryRoot(cwd: string): string {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
	}

	async function waitSupervisor(): Promise<void> {
		try { await intercom.waitReady(undefined, { peerOnly: true }); }
		catch (error) { throw new SupervisorFailure(String(error)); }
	}

	async function startSupervisor(ctx: ExtensionContext, isCurrent = () => !intercom.ended): Promise<void> {
		if (intercom.ended) throw new Error("Session ended before supervisor startup.");
		repositoryRoot(ctx.cwd);
		const sourceSessionFile = ctx.sessionManager.getSessionFile();
		if (!sourceSessionFile) throw new Error("The current session is not persisted, so it cannot be forked.");
		if (state.supervisorPaneId && state.approvalId) {
			intercom.configure(state.approvalId, "worker", ctx, false);
			await waitSupervisor();
			return;
		}
		beginReview(ctx);
		const binding = state.approvalId;
		const current = () => isCurrent() && !intercom.ended && state.approvalId === binding;
		let paneId: string | null = null;
		try {
			paneId = await openSupervisorPane({
				cwd: ctx.cwd,
				sourceSessionFile,
				workerSessionId: ctx.sessionManager.getSessionId(),
				planPath: planPath(ctx),
				approvalId: state.approvalId!,
				extensionPath: fileURLToPath(import.meta.url),
				model: state.supervisorModel,
			}, (opened) => {
				if (!current()) throw new Error("Supervisor startup was cancelled.");
				paneId = opened;
				state = { ...state, supervisorPaneId: opened };
				persist();
			});
		} catch (error) {
			if (paneId) throw new SupervisorFailure(`Supervisor startup failed in Herdr pane ${paneId}; it remains open for inspection. ${error instanceof Error ? error.message : String(error)}`);
			throw new SupervisorFailure(String(error));
		}
		if (!current()) throw new Error("Supervisor startup was cancelled.");
		state = { ...state, supervisorPaneId: paneId };
		persist();
		await waitSupervisor();
	}

	let viewGeneration = 0;
	let viewTimer: ReturnType<typeof setInterval> | undefined;
	let planWatcher: FSWatcher | undefined;
	let planEditTimer: ReturnType<typeof setTimeout> | undefined;
	let planReviewPending = false;

	async function publishWorkerView(ctx: ExtensionContext, reason: "ready" | "settled" | "interval" | "started" | "status" | "plan"): Promise<void> {
		if (state.phase !== "working" || state.mode === "solo" || modelError || !intercom.bound) return;
		const generation = ++viewGeneration;
		const binding = state.approvalId;
		const background = reason === "started" ? { quiet: false, description: "agent starting; background state not queried" } : await backgroundState(pi);
		if (!intercom.bound || modelError || generation !== viewGeneration || binding !== state.approvalId || state.phase !== "working") return;
		refreshSignoffs(ctx);
		updateWidget(ctx);
		const plan = readPlan(ctx);
		const entries = ctx.sessionManager.getBranch();
		const view = workerView(entries, reason, reason !== "started" && ctx.isIdle(), {
			sourceSession: ctx.sessionManager.getSessionFile()!, latestDirection: state.latestDirection,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected",
			contextPercent: ctx.getContextUsage()?.percent,
			since: intercom.acknowledgedEntry, background: background.description,
			planReview: `Plan: ${planRel(ctx)}\n${planReview(plan)}`,
		});
		intercom.view(view, reason, entries.at(-1)?.id, background.quiet);
		if (reason !== "started" && reason !== "status" && intercom.connected && state.previousPlan !== plan) {
			state = { ...state, previousPlan: plan };
			persist();
		}
		// A fully signed-off plan remains paired: the worker or supervisor may discover a missed
		// requirement after completion and exchange one more view without recreating the pairing.
	}

	function startWorkerTimers(ctx: ExtensionContext): void {
		if (!planWatcher) {
			const activePath = planPath(ctx);
			try {
				// Watch the containing directory so atomic replacement does not lose the file watch.
				planWatcher = watch(join(ctx.cwd, PLAN_DIR), (_event, filename) => {
					if (intercom.ended || state.phase !== "working") return;
					if (filename && join(ctx.cwd, PLAN_DIR, filename.toString()) !== activePath) return;
					if (planEditTimer) clearTimeout(planEditTimer);
					planEditTimer = setTimeout(() => {
						planEditTimer = undefined;
						if (intercom.ended || state.phase !== "working" || planPath(ctx) !== activePath) return;
						updateWidget(ctx);
						if (readPlan(ctx) === state.previousPlan) return;
						if (!ctx.isIdle()) { planReviewPending = true; return; }
						void publishWorkerView(ctx, "plan").catch(error => { if (!intercom.ended) ctx.ui.notify(`Plan review failed: ${String(error)}`, "error"); });
					}, 150);
				});
				planWatcher.on("error", error => { if (!intercom.ended) ctx.ui.notify(`Plan watch failed: ${error.message}`, "error"); });
			} catch (error) { ctx.ui.notify(`Could not watch active plan: ${String(error)}`, "warning"); }
		}
		if (!viewTimer) viewTimer = setInterval(() => {
			void publishWorkerView(ctx, "interval").catch(error => { if (!intercom.ended) ctx.ui.notify(`Worker view failed: ${String(error)}`, "error"); });
		}, 60 * 60_000);
	}

	function stopWorkerTimers(): void {
		planWatcher?.close();
		planWatcher = undefined;
		if (planEditTimer) clearTimeout(planEditTimer);
		planEditTimer = undefined;
		planReviewPending = false;
		if (viewTimer) clearInterval(viewTimer);
		viewTimer = undefined;
	}

	async function stopSupervisor(): Promise<boolean> {
		recoveryAttempt = undefined;
		readyAttempt = undefined;
		if (!state.supervisorPaneId) { stopWorkerTimers(); intercom.detach(); return true; }
		try {
			await closeSupervisorPane(state.supervisorPaneId);
			stopWorkerTimers();
			intercom.detach();
			state = { ...state, supervisorPaneId: null };
			persist();
			return true;
		} catch {
			return false;
		}
	}

	function updateWidget(ctx: ExtensionContext): void {
		refreshSignoffs(ctx);
		const paused = pauseReason(ctx);
		if (paused) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "goals paused"));
			ctx.ui.setWidget(WIDGET_KEY, [`pi-goals paused: ${paused}`]);
			return;
		}
		if (state.phase === "planning") {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "planning"));
			ctx.ui.setWidget(WIDGET_KEY, ["pi-goals: drafting goals"]);
			return;
		}
		const goals = scanGoals(readPlan(ctx));
		if (goals.length === 0) {
			const solo = state.phase === "working" && state.mode === "solo";
			ctx.ui.setStatus(STATUS_KEY, solo ? "UNSUPERVISED worker" : undefined);
			ctx.ui.setWidget(WIDGET_KEY, solo ? ["UNSUPERVISED: no goal lines found. Plan retained; supervisor sign-off unavailable. /goals restart"] : undefined);
			return;
		}
		const isSignedOff = (subject: string) => state.signedOffGoals.includes(goalKey(subject));
		const done = goals.filter(g => g.status === "done" && isSignedOff(g.subject)).length;
		const claimed = goals.filter(g => g.status === "done" && !isSignedOff(g.subject));
		const liveGoals = goals.filter(g => g.status === "active" || g.status === "open");
		const supervision = "supervised worker";
		const connectedGlyph = intercom.connected ? " 👁" : "";
		const stateLabel = state.phase === "working" && state.mode === "solo" ? " · UNSUPERVISED" : claimed.length ? ` · ${supervision} · ${claimed.length} claimed, awaiting review${connectedGlyph}` : liveGoals.length > 0 ? state.phase === "working" ? ` · ${supervision}${connectedGlyph}` : " · inactive draft" : " · complete";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◷ ${done}/${goals.length} goals${stateLabel}`));
		const mark: Record<GoalStatus, string> = { done: "✔", active: "▸", open: "◻", cancelled: "✗" };
		// Only live goals get lines so finished work never pushes current work off screen. The active
		// goal also shows its open subtasks: this file is the task list, so the widget is the task list.
		// No path line: the session id makes it too long to be useful in the widget.
		const plan = readPlan(ctx);
		const lines: string[] = claimed.map(g => `? claimed complete; ${state.mode === "solo" ? "unreviewed (solo)" : "awaiting supervisor review"}: ${g.subject}`);
		if (state.phase === "working" && state.mode === "solo") lines.unshift(`UNSUPERVISED: ${state.soloReason} Supervisor sign-off unavailable. /goals restart`);
		else if (liveGoals.length === 0 && claimed.length === 0) lines.push("✔ complete");
		for (const g of liveGoals) {
			lines.push(`${mark[g.status]} ${g.status === "active" && state.mode !== "solo" ? "working… " : ""}${g.subject}`);
			if (g.status === "active") lines.push(...openSubtasks(plan, g.line).slice(0, 3).map((s) => ctx.ui.theme.fg("muted", `   ◦ ${s}`)));
		}
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	// --- /goals: enter plan mode or configure supervision -- Pi/Codex -----------------------------

	async function chooseGoalsAction(ctx: ExtensionContext): Promise<string | null> {
		const status = state.phase === "planning"
			? `Draft plan active at ${planRel(ctx)}. It has not approved implementation.`
			: state.phase === "working" && state.mode === "solo"
				? `UNSUPERVISED worker active for ${planRel(ctx)}. The approved plan is preserved.`
				: state.phase === "working"
					? `Supervised worker active for ${planRel(ctx)}.`
					: "No active plan.";
		const choices = state.phase === "planning"
			? ["Keep drafting", "Exit planning (keep draft)", "Start a new plan"]
			: state.phase === "working" && state.mode === "solo"
				? ["Keep working unsupervised", "Restore supervision", "Reconnect worker model", "Start a new plan", "Disconnect current plan"]
				: state.phase === "working"
					? ["Keep working", "Reconnect existing supervision", "Replace supervisor", "Start a new plan", "Disconnect current plan"]
					: ["Start a plan", "Cancel"];
		const choice = await ctx.ui.select(status, choices);
		if (!choice || choice === "Cancel" || choice.startsWith("Keep")) return null;
		if (choice === "Exit planning (keep draft)") return "noplan";
		if (choice === "Restore supervision" || choice === "Replace supervisor") return "restart";
		if (choice === "Reconnect worker model" || choice === "Reconnect existing supervision") return "reconnect";
		if (choice === "Disconnect current plan") return "clear";
		const objective = await ctx.ui.editor("What should the new plan achieve?", "");
		return objective?.trim() ? `plan ${objective.trim()}` : null;
	}

	pi.registerCommand("goals", {
		description: "Plan goals and manage visible supervision. /goals opens safe actions; /goals plan <objective> deliberately starts or replaces planning.",
		getArgumentCompletions: prefix => goalCommandCompletions(prefix, "worker"),
		handler: async (args, ctx) => {
			const command = {};
			let arg = args.trim();
			if (!arg) {
				const action = await chooseGoalsAction(ctx);
				if (!action) return;
				arg = action;
			}
			const explicitPlan = arg === "plan" || arg.startsWith("plan ");
			if (explicitPlan) arg = arg.slice("plan".length).trim();
			if (recoveryCommand && !explicitPlan && !["work", "reconnect", "restart", "clear"].includes(arg)) {
				ctx.ui.notify("Goal recovery is in progress. Wait for it, or use /goals reconnect, /goals restart, /goals clear, or /goals plan <objective> to intentionally supersede it.", "warning");
				return;
			}
			if (!explicitPlan && arg === "solo") {
				if (state.phase !== "working") { ctx.ui.notify("Solo requires an already-approved plan. A draft still needs Ready.", "warning"); return; }
				if (modelError) { ctx.ui.notify(`Cannot enter solo: ${pauseReason(ctx)}`, "warning"); return; }
				if (state.mode === "solo") { ctx.ui.notify("Already UNSUPERVISED; plan preserved, supervisor sign-off unavailable. /goals restart restores supervision.", "warning"); return; }
				commandAttempt = command;
				readyAttempt = undefined;
				enterSolo(ctx, "You explicitly selected /goals solo.");
				return;
			}
			if (!explicitPlan && arg === "supervise") { ctx.ui.notify("This is the worker session. Run /goals supervise in the saved supervisor session; no new pairing was created.", "warning"); return; }
			if (!explicitPlan && arg === "work") {
				if (state.phase === "working" && state.mode === "solo") { ctx.ui.notify("Already an unsupervised worker. Use /goals reconnect for worker-model recovery or /goals restart to restore supervision.", "warning"); return; }
				if (state.phase !== "working" || !state.approvalId || !state.supervisorPaneId) { ctx.ui.notify("No approved worker pairing to reconnect. A retained draft still needs Ready.", "warning"); return; }
				arg = "reconnect";
			}
			if (!explicitPlan && arg === "noplan") {
				if (state.phase !== "planning") { ctx.ui.notify("Not in planning mode; the current plan is unchanged.", "info"); return; }
				commandAttempt = command;
				readyAttempt = undefined;
				planningContextPending = false;
				resyncReason = null;
				stopWorkerTimers();
				intercom.detach();
				models.leave();
				state = { ...state, phase: null };
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`Planning exited. Draft preserved at ${planRel(ctx)}; no implementation was approved or started.`, "info");
				return;
			}
			if (!explicitPlan && (arg === "reconnect" || arg === "restart")) {
				if (!state.phase) { ctx.ui.notify("No active plan to recover.", "info"); return; }
				if (!ctx.isIdle()) { ctx.ui.notify("Stop the current turn before recovering goal supervision.", "warning"); return; }
				commandAttempt = command;
				const connectedBeforeRecovery = intercom.connected;
				readyAttempt = undefined;
				recoveryAttempt = undefined;
				const version = state.planVersion;
				const phase = state.phase;
				const current = () => !intercom.ended && commandAttempt === command && state.planVersion === version && state.phase === phase;
				recoveryCommand = command;
				try {
					await restoreModel(state.phase === "planning" ? "planning" : "worker", ctx);
					if (!current()) return;
					if (state.mode === "solo" && arg === "reconnect") {
						ctx.ui.notify("Worker model restored; remaining UNSUPERVISED. Use /goals restart to restore supervision.", "warning");
						updateWidget(ctx);
						return;
					}
					if (arg === "restart") {
						const stopped = await stopSupervisor();
						if (!current()) return;
						if (!stopped) {
							// Model restoration paused our readiness, but a failed close did not end the pairing.
							if (connectedBeforeRecovery) intercom.markReady();
							throw new Error("Could not close the tracked supervisor pane; no replacement was opened.");
						}
						state = { ...state, supervisorPaneId: null, approvalId: null };
						persist();
					}
					if (state.phase === "working" || state.supervisorPaneId) {
						if (arg === "reconnect") {
							if (!state.approvalId) throw new Error("No saved supervision binding. Use /goals restart.");
							intercom.configure(state.approvalId, "worker", ctx, false);
							await waitSupervisor();
						} else await startSupervisor(ctx, current);
					}
					if (!current()) return;
					if (state.phase === "working") {
						state = { ...state, mode: "supervised", soloReason: null };
						persist();
						intercom.markReady();
						startWorkerTimers(ctx);
					}
					ctx.ui.notify(state.phase === "planning" ? "Planning model restored. Choose Ready when the plan is agreed." : "Goal supervision reconnected; the current plan is unchanged.", "info");
				} catch (error) {
					if (!current()) return;
					if (error instanceof SupervisorFailure && state.phase === "working" && !modelError) {
						if (planIsComplete(ctx)) {
							ctx.ui.notify(`Supervisor recovery failed: ${error.message} The completed plan remains supervised and its recorded sign-offs are unchanged.`, "warning");
							updateWidget(ctx);
							return;
						}
						enterSolo(ctx, `Supervisor recovery failed: ${error.message}`);
						return;
					}
					ctx.ui.notify(`Goal recovery failed: ${String(error)} Use /goals reconnect to retry, or /goals restart to explicitly replace the tracked pane.`, "warning");
				} finally { if (recoveryCommand === command) recoveryCommand = undefined; }
				updateWidget(ctx);
				return;
			}
			if (!explicitPlan && arg === "clear") {
				if (state.planVersion === null) {
					ctx.ui.notify("No active plan to disconnect.", "info");
					return;
				}
				commandAttempt = command;
				const currentPlan = planRel(ctx);
				if (!(await stopSupervisor())) {
					ctx.ui.notify("Could not close the visible supervisor; the plan remains connected.", "warning");
					return;
				}
				state = { ...state, phase: null, supervisorPaneId: null, approvalId: null, planVersion: null };
				models.leave();
				modelError = null;
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`Disconnected from ${currentPlan}; the file remains on disk.`, "info");
				return;
			}
			if (!explicitPlan && (arg === "model" || arg.startsWith("model "))) {
				if (state.phase === "working") {
					ctx.ui.notify("Run /goals clear before changing the active supervisor model.", "warning");
					return;
				}
				commandAttempt = command;
				if (!(await stopSupervisor())) {
					ctx.ui.notify("Could not close the visible supervisor; its model was not changed.", "warning");
					return;
				}
				const ref = arg.slice("model".length).trim();
				state = { ...state, supervisorModel: ref || null, supervisorPaneId: null, approvalId: null };
				persist();
				ctx.ui.notify(`Goal-supervisor model ${ref ? `set to ${ref}` : "reset to the remembered supervisor model"}.`, "info");
				return;
			}
			if (state.phase && !explicitPlan) {
				ctx.ui.notify("The active plan is unchanged. Use /goals plan <objective> to deliberately replace it, or submit /goals with no arguments for safe actions and recovery commands.", "warning");
				return;
			}
			commandAttempt = command;
			if (!(await stopSupervisor())) {
				ctx.ui.notify("Could not close the visible supervisor; no new plan was started.", "warning");
				return;
			}
			await restoreModel("planning", ctx);
			state = { ...state, phase: "planning", mode: "supervised", soloReason: null, supervisorPaneId: null, approvalId: null, planVersion: nextVersion(ctx), latestDirection: arg, signedOffGoals: [], previousPlan: null };
			planningContextPending = true;
			resyncReason = null;
			writePlan(ctx, "");
			persist();
			updateWidget(ctx);
			// The drafting rules are sent ONCE, with the seed. v2 re-injected them every turn, which is
			// why plan mode read as never-ending: every reply re-armed it. They come back only on a
			// resync (session start / compaction), when the model has genuinely lost them.
			const seed = arg
				? `We're in plan mode. Objective: ${arg}\n\n${planDrafting}\n\nWrite the plan to ${planPath(ctx)}.`
				: `We're in plan mode. Tell me what you want to plan.\n\n${planDrafting}\n\nWrite the plan to ${planPath(ctx)}.`;
			pi.sendUserMessage(seed, { deliverAs: "followUp" });
		},
	});

	// --- hooks --------------------------------------------------------------------------------------

	/** Restore the complete plan once after session start or compaction. */
	function dueInjection(ctx: ExtensionContext, plan: string): string | null {
		if (state.phase !== "working" || !plan.trim() || !resyncReason) return null;
		const why = resyncReason;
		resyncReason = null;
		return resync(plan, planRel(ctx), why, state.mode === "solo");
	}

	// The phase snapshot enters context only when planning starts or context was lost.
	pi.on("before_agent_start", async (_event, ctx) => {
		const paused = pauseReason(ctx);
		if (paused) return { systemPrompt: `${ctx.getSystemPrompt()}\n\nGoal work is paused: ${paused} Do not implement or sign off goals. Human input and read-only diagnosis remain available; wait for recovery before resuming autonomous work.` };
		if (state.phase === "working" && state.mode === "solo") return { systemPrompt: `${ctx.getSystemPrompt()}\n\nYou are the UNSUPERVISED implementation worker for ${planRel(ctx)}. Reason: ${state.soloReason} Continue the approved plan, preserve its goals and save evidence and verification results. There is no supervisor; do not wait for steering, call CompleteGoal, or claim supervised sign-off. Report completion as unreviewed. Use /goals restart to restore supervision.` };
		if (state.phase === "working") {
			return {
				systemPrompt: `${ctx.getSystemPrompt()}\n\nYou are the implementation worker for ${planRel(ctx)}. Keep the full conversation and do the work directly. A stronger read-only supervisor watches this session through pi-intercom and can steer you. Commit your evidence before asking for sign-off; never commit or discard unrelated changes to satisfy the clean-worktree gate. The supervisor can explicitly accept an inspected unchanged dirty state with ApproveGoal force and a reason. Stop when a goal appears complete so the supervisor can inspect a settled worker view. Call CompleteGoal only after the supervisor says it recorded approval. -- PI[Kimi K3]`,
			};
		}
		if (!planningContextPending) return;
		planningContextPending = false;
		return { message: { customType: PLANNING_CONTEXT, content: planningState(planPath(ctx)), display: false } };
	});

	// PI: Working turns never see an obsolete planning snapshot. Auto-compaction retries skip
	// before_agent_start, so context restores the planning snapshot exactly once in that path.
	pi.on("context", async (event, ctx) => {
		const messages = state.phase === "planning" ? event.messages : event.messages.filter((message) => (message as { customType?: string }).customType !== PLANNING_CONTEXT);
		const removedPlanningContext = messages.length !== event.messages.length;
		// Ready may compact the worker before changing phase. Its custom instructions already preserve
		// the approved plan, so never append an extension message to that compaction transaction.
		if (state.phase === "planning" && planningContextPending && !readyAttempt) {
			planningContextPending = false;
			return { messages: [...messages, { role: "user" as const, content: [{ type: "text" as const, text: planningState(planPath(ctx)) }], timestamp: Date.now() }] };
		}
		const text = dueInjection(ctx, readPlan(ctx));
		if (!text) return removedPlanningContext ? { messages } : undefined;
		return { messages: [...messages, { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() }] };
	});

	// PI: Human plan-mode replies are durable evidence of the interview, not model summaries.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		state = { ...state, latestDirection: event.text };
		persist();
		if (state.phase === "planning") writePlan(ctx, appendInterview(readPlan(ctx), event.text));
	});

	pi.on("agent_start", async (_event, ctx) => {
		// PI/OpenAI: Started views update approval safety without starting supervisor inference.
		await publishWorkerView(ctx, "started");
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateWidget(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const paused = pauseReason(ctx);
		if (paused && !(["read", "grep", "find", "ls"].includes(event.toolName) || (event.toolName === "bash" && isPlanningReadOnlyCommand(String((event.input as { command?: string }).command))))) {
			return { block: true, terminate: true, reason: `Goal work is paused: ${paused} Only read-only diagnosis is available.` };
		}
		if (state.phase === "planning") {
			if (PLAN_MODE_BLOCKED_TOOLS.includes(event.toolName)) {
				const target = (event.input as { path?: string }).path;
				if (target && resolve(ctx.cwd, target) === resolve(planPath(ctx))) return;
				return { block: true, reason: `Planning is read-only: only ${planRel(ctx)} may be written. Agree the plan, then choose Ready.` };
			}
			if (event.toolName === "bash" && !isPlanningReadOnlyCommand(String((event.input as { command?: string }).command))) {
				return { block: true, reason: "Planning is read-only: inspect facts without writes or pipes, then put the change in the plan." };
			}
			return;
		}
	});

	// A compaction loses context, so restore either the planning snapshot or the working plan once.
	pi.on("session_compact", async () => {
		if (state.phase === "planning") {
			if (!readyAttempt) planningContextPending = true;
		} else if (state.phase === "working") resyncReason = "The session was just compacted.";
	});

	pi.on("agent_end", async event => {
		const last = event.messages.filter(message => message.role === "assistant").at(-1);
		lastAssistantError = last?.stopReason === "error" ? last.errorMessage ?? "Worker model returned an error without a reason." : undefined;
	});

	// PI: Print after Pi settles. agent_end is still streaming, so its message queues behind the menu.
	pi.on("agent_settled", async (_event, ctx) => {
		if (state.phase === "working" && lastAssistantError) {
			modelError = `Worker model failed after Pi recovery: ${lastAssistantError}`;
			lastAssistantError = undefined;
			intercom.markNotReady();
			ctx.ui.notify(`Goal work paused: ${pauseReason(ctx)} No mode or model substitution was made.`, "error");
			updateWidget(ctx);
			return;
		}
		if (state.phase === "working") {
			await publishWorkerView(ctx, "status");
			updateWidget(ctx);
			if (!planReviewPending) return;
			planReviewPending = false;
			await publishWorkerView(ctx, "plan");
			return;
		}
		if (state.phase !== "planning" || modelError || !ctx.hasUI) return;
		const version = state.planVersion;
		const planning = () => !intercom.ended && state.phase === "planning" && state.planVersion === version;
		let printed = "";
		while (true) {
			if (!planning()) return;
			const plan = readPlan(ctx);
			if (scanGoals(plan).length === 0) {
				if (plan.trim()) ctx.ui.notify(`The plan has no goal line. Revise ${planRel(ctx)} to add one.`, "warning");
				return;
			}
			if (plan !== printed) {
				printed = plan;
				pi.sendMessage({ customType: "plan", content: plan, display: true });
			}
			const choice = await ctx.ui.select(`Plan drafted in ${planRel(ctx)}.`, ["Ready", "Refine", "Edit", "Cancel"]);
			if (!planning()) return;
			if (choice === "Refine") {
				const notes = await ctx.ui.editor("What should change about the plan?", "");
				if (!planning()) return;
				if (!notes?.trim()) continue;
				state = { ...state, latestDirection: notes };
				persist();
				writePlan(ctx, appendInterview(plan, notes));
				planningContextPending = true;
				pi.sendUserMessage(`Revise the plan at ${planPath(ctx)} using these human notes:\n\n${notes}\n\nKeep the same goal structure.`, { deliverAs: "followUp" });
				return;
			}
			if (choice === "Edit") {
				const edited = await ctx.ui.editor("Edit the plan", plan);
				if (!planning()) return;
				if (edited !== undefined && edited !== plan) writePlan(ctx, edited);
				continue;
			}
			if (choice === "Cancel") {
				if (!(await stopSupervisor())) { ctx.ui.notify("Could not close the tracked supervisor; plan was not discarded.", "warning"); return; }
				rmSync(planPath(ctx), { force: true });
				models.leave();
				state = { ...state, phase: null, supervisorPaneId: null, approvalId: null, planVersion: null };
				persist();
				updateWidget(ctx);
				ctx.ui.notify("Plan discarded.", "info");
				return;
			}
			if (choice !== "Ready") return;
			const attempt = {};
			readyAttempt = attempt;
			const current = () => !intercom.ended && readyAttempt === attempt && state.planVersion === version;
			const checkApprovedPlan = () => {
				if (readPlan(ctx) !== plan) throw new Error("The plan changed after Ready was selected. Review the changed plan and select Ready again; the existing supervisor pane is retained.");
			};
			try {
				checkApprovedPlan();
				await compactApprovedWorker(ctx);
				if (!current()) return;
				checkApprovedPlan();
				await restoreModel("worker", ctx);
				if (!current()) return;
				checkApprovedPlan();
				let supervisorFailure: SupervisorFailure | undefined;
				try { await startSupervisor(ctx, current); }
				catch (error) { if (!(error instanceof SupervisorFailure)) throw error; supervisorFailure = error; }
				if (!current()) return;
				checkApprovedPlan();
				state = { ...state, phase: "working", mode: "supervised", soloReason: null };
				resyncReason = "The plan was approved.";
				persist();
				if (supervisorFailure) {
					readyAttempt = undefined;
					enterSolo(ctx, `Supervisor startup failed after you selected Ready: ${supervisorFailure.message}`);
					return;
				}
				intercom.markReady();
				startWorkerTimers(ctx);
				await publishWorkerView(ctx, "ready");
				if (!current()) return;
				checkApprovedPlan();
				updateWidget(ctx);
				ctx.ui.notify(`Visible supervisor opened in Herdr pane ${state.supervisorPaneId}.`, "info");
				pi.sendUserMessage("The plan is approved. Begin implementation as the worker.");
				readyAttempt = undefined;
			} catch (error) {
				if (!current()) return;
				readyAttempt = undefined;
				// A successful pre-fork compaction replaced the planning conversation. Restore the
				// one-shot plan context before returning to planning after any later failure.
				planningContextPending = true;
				intercom.markNotReady();
				stopWorkerTimers();
				ctx.ui.notify(`Goal supervisor could not start: ${error instanceof Error ? error.message : String(error)} Use /goals reconnect to retry, or /goals restart to replace the tracked pane.`, "warning");
				state = { ...state, phase: "planning" };
				persist();
				updateWidget(ctx);
			}
			return;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const last = ctx.sessionManager
			.getEntries()
			.filter((e: { type?: string; customType?: string }) => e.type === "custom" && e.customType === STATE)
			.pop() as { data?: PlanState } | undefined;
		state = {
			phase: last?.data?.phase ?? null,
			mode: last?.data?.mode ?? "supervised",
			soloReason: last?.data?.soloReason ?? null,
			supervisorModel: last?.data?.supervisorModel ?? null,
			supervisorPaneId: last?.data?.supervisorPaneId ?? null,
			approvalId: last?.data?.approvalId ?? null,
			planVersion: last?.data?.planVersion ?? null,
			latestDirection: last?.data?.latestDirection ?? "",
			signedOffGoals: last?.data?.signedOffGoals ?? [],
			previousPlan: last?.data?.previousPlan ?? null,
		};
		modelError = state.phase ? "Role model restoration is pending." : null;
		planningContextPending = state.phase === "planning";
		resyncReason = state.phase === "working" ? "New session." : null;
		if (state.phase === "working" && state.mode === "supervised" && state.approvalId) {
			intercom.configure(state.approvalId, "worker", ctx, false);
			startWorkerTimers(ctx);
		}
		try {
			if (state.phase) await restoreModel(state.phase === "planning" ? "planning" : "worker", ctx);
		} catch (error) {
			if (!intercom.ended) ctx.ui.notify(`Goal work paused: ${String(error)} Use /model, then /goals reconnect.`, "warning");
		}
		if (intercom.ended) return;
		if (state.phase === "working" && state.mode === "supervised" && state.approvalId && !modelError) {
			intercom.markReady();
			recoverSupervisor(ctx);
		}
		updateWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopWorkerTimers();
	});

	pi.registerTool({
		name: "CompleteGoal",
		label: "Goal signoff",
		description: completeGoalDescription,
		parameters: Type.Object({
			goal: Type.String({ description: completeGoalParamDescription }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) return result("Goal sign-off cancelled; no completion recorded.", true);
			const binding = state.approvalId;
			const version = state.planVersion;
			if (state.phase !== "working") return result("Planning is not approved. Choose Ready before signing off a goal.", true);
			if (state.mode === "solo") return result("Supervisor sign-off is unavailable in solo mode. Save evidence and use /goals restart for review; no completion recorded.", true);
			if (pauseReason(ctx)) return result(`Goal sign-off blocked: ${pauseReason(ctx)}`, true);
			if (!state.approvalId) return result("Goal sign-off blocked: no current supervisor review.", true);
			const background = await backgroundState(pi);
			if (signal?.aborted || intercom.ended || state.approvalId !== binding || state.planVersion !== version || state.phase !== "working") return result("Goal sign-off cancelled or superseded; no completion recorded.", true);
			if (intercom.ended || !background.quiet || pauseReason(ctx)) return result(`Goal sign-off blocked: ${pauseReason(ctx) ?? background.description}`, true);
			const plan = readPlan(ctx);
			if (!plan.trim()) return result(`No plan file at ${planRel(ctx)}. Run /goals to draft one.`, true);
			const block = goalBlock(plan, params.goal);
			if (!block) return result(`No unique open goal line matched "${params.goal}" in ${planRel(ctx)}.`, true);
			const approval = readApproval(approvalPath(ctx.cwd, ctx.sessionManager.getSessionId(), params.goal));
			let repository: ReturnType<typeof repositoryState>;
			try {
				repository = repositoryState(ctx.cwd, Boolean(approval?.force));
			} catch (error) {
				return result(`Goal sign-off could not inspect the repository: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			if (!repository.cleanWorktree && !approval?.force) return result("Goal sign-off blocked: worktree is dirty. Request supervisor inspection, not an unrelated cleanup commit.", true);
			if (!approvalMatches(approval, {
				approvalId: state.approvalId,
				goal: params.goal,
				planPath: planPath(ctx),
				goalBlockHash: hashGoalBlock(block),
				repoRoot: repository.repoRoot,
				head: repository.head,
				tree: repository.tree,
				cleanWorktree: repository.cleanWorktree,
				worktree: repository.worktree,
			})) return result("Goal sign-off blocked: no matching supervisor approval checkpoint. Request a fresh supervisor review.", true);
			const ticked = tickGoal(plan, params.goal);
			if (!ticked) return result(`No unique exact goal line matched "${params.goal}" in ${planRel(ctx)}.`, true);
			if (signal?.aborted) return result("Goal sign-off cancelled; no completion recorded.", true);
			writePlan(ctx, appendLog(ticked, `${stamp()} mechanically signed off "${params.goal}" after matching supervisor approval`));
			state = { ...state, signedOffGoals: [...state.signedOffGoals.filter(goal => goal !== goalKey(params.goal)), goalKey(params.goal)] };
			persist();
			updateWidget(ctx);
			return result(`Sign-off accepted. Goal ticked [x] in ${planRel(ctx)}.`);
		},
	});
}

// --- helpers (module scope) --------------------------------------------------------------------

// A compact changed span, not a second plan parser. Worker views bound its serialized size.
function planDiff(before: string, after: string): string {
	if (before === after) return "none";
	const old = before.split("\n");
	const next = after.split("\n");
	let start = 0;
	while (start < old.length && start < next.length && old[start] === next[start]) start++;
	let oldEnd = old.length;
	let nextEnd = next.length;
	while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) { oldEnd--; nextEnd--; }
	return [`@@ from line ${start + 1} @@`, ...old.slice(start, oldEnd).map(line => `- ${line}`), ...next.slice(start, nextEnd).map(line => `+ ${line}`)].join("\n");
}

function result(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function mutatingReadCommand(part: string): boolean {
	return /(?:^|\s)--output(?:=|\s|$)|^find\b.*\s-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)(?:\s|$)/.test(part)
		|| (/^git\s+branch\b/.test(part) && !/^git\s+branch(?:\s+(?:--show-current|--list|-a|--all|-r|--remotes|-v|-vv))*$/.test(part));
}

function isPlanningReadOnlyCommand(command: string): boolean {
	if (/[|><`$\n\r]/.test(command)) return false;
	return command.split(/&&|;/).every((raw) => {
		const part = raw.trim();
		return !mutatingReadCommand(part) && /^(?:cd\b|pwd|ls\b|git\s+(?:status|log|diff|show|branch)\b|rg\b|grep\b|find\b|head\b|tail\b|wc\b|stat\b|test\b)\b/.test(part);
	});
}


/** Local time, not UTC: agents freehand-stamp their manual ## Log lines from the local clock they
 *  see, so a UTC tool stamp made the trail read as two different afternoons (dogfood finding). */
function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Tick the goal line whose subject exactly matches `goal` (trimmed, case-insensitive) to [x].
 *  Null when there is no unique exact match. Reuses GOAL_LINE and is deliberately not fuzzy. */
export function tickGoal(plan: string, goal: string): string | null {
	const lines = plan.split("\n");
	const want = goal.trim().toLowerCase();
	const hits = scanGoals(plan).filter(g => g.subject.toLowerCase() === want).map(g => g.line);
	if (hits.length !== 1) return null;
	lines[hits[0]] = lines[hits[0]].replace(/\[[ xX/-]\]/, "[x]");
	return lines.join("\n");
}

/** Append one line under ## Log (creating the section at EOF if absent). */
export function appendLog(text: string, entry: string): string {
	const lines = text.split("\n");
	const line = `- ${entry}`;
	const header = lines.findIndex((l) => FOLD_LINE.test(l));
	if (header === -1) return `${text.replace(/\n+$/, "")}\n\n## Log\n${line}\n`;
	let insertAt = header + 1;
	for (let i = header + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) break;
		if (/^\s*-\s+/.test(lines[i])) insertAt = i + 1;
	}
	lines.splice(insertAt, 0, line);
	return lines.join("\n");
}

/** PI: Preserve human plan-mode answers verbatim below the fold. */
export function appendInterview(text: string, answer: string): string {
	const lines = text.split("\n");
	const header = lines.findIndex((l) => /^##\s+Interview\s*$/i.test(l));
	const entry = [`### ${stamp()}`, "", ...answer.split("\n").map((line) => `> ${line}`), ""];
	if (header === -1) return `${text.replace(/\n+$/, "")}\n\n## Interview\n\n${entry.join("\n")}`;
	let insertAt = header + 1;
	while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt])) insertAt++;
	lines.splice(insertAt, 0, ...entry);
	return lines.join("\n");
}
