/**
 * PI: pi-goals v2 drafts goals into .pi/plan/<session_id>-vN.md, the agent works them with its
 * normal Edit tool, and a fresh read-only judge signs each goal off through the one blessed tool,
 * CompleteGoal.
 *
 * PI: Each /goals call makes a new plan version, `.pi/plan/<session_id>-vN.md`. The selected version
 * stays in session state across resume and compaction. Old plans stay on disk but inert, so a new
 * conversation cannot silently edit them. `/goals clear` only disconnects this session; the filename is the arm switch: a session that never ran
 * /goals has no active plan, so the widget, injections, and CompleteGoal all stay silent.
 *
 * The v1 lesson: the parser existed so TypeScript could read the plan, but almost every reader is a
 * model. So v2 has NO parser and no schema. The harness does exactly three things for a
 * cooperative-but-confused model:
 *   1. memory  — a saved extension message on two triggers: the plan went stale for STALE_TURNS
 *                turns (send the working set above ## Log), or the session started / compacted
 *                (send the whole file, appendix included). v2 sent the whole
 *                file every turn; pi-tasks tried that and deleted it as "wallpaper noise that
 *                trains the model to ignore the task block" (tintinweb/pi-tasks CHANGELOG.md:149),
 *                and the always-present CompleteGoal description carries the contract instead.
 *   2. format  — a skeleton convention taught in planDrafting (prompts.ts), not validated
 *   3. eyes    — CompleteGoal spawns a strictly read-only pi subprocess (--no-session, no bash)
 *                that gets the whole plan file plus a unique exact goal subject, checks the
 *                evidence (including the agent's saved verify output) against the repo, and
 *                returns VERDICT: accept|reject. CompleteGoal rejects ambiguous or drifted
 *                subjects before review and asks the worker to retry with the exact subject.
 *
 * The judge reads the goal's format and validates evidence (a placeholder gets rejected in
 * words); code binds sign-off to one exact goal identity. The extension's only
 * writes are the sign-off: append a log line to ## Log (the audit trail) and tick the goal [x] when
 * one unique exact goal subject matches. CompleteGoal persists conclusive/inconclusive sign-offs
 * separately from checkboxes, so manual ticks stay visible claims even across reload.
 *
 * Judge ran but failed/errored/timed out, or returned no VERDICT line => accepted_inconclusive: the
 * working agent is never blocked on judge infra; the log line says the judge ran but failed. There
 * is no pre-emptive "no model" path -- a null judgeModel just omits --model so pi's configured
 * default runs the judge, so inconclusive always means "ran but failed", never "couldn't start".
 *
 * All model-facing text lives in prompts.ts, in flow order.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import supervise from "./internal/supervisor/index.js";
import {
	alignmentPolicy,
	completeGoalDescription,
	completeGoalParamDescription,
	discussPlan,
	judgeSystem,
	judgeUser,
	planDrafting,
	planningState,
	reminder,
	resync,
	waivesAlignment,
} from "./prompts.js";
import { RoleModels } from "./role-models.js";
import { focusSupervisor, initializeSupervisor, planHash, type SupervisorBinding, startSupervisor, supervisorBootstrap } from "./supervisor.js";

const STATE = "pi-goals-state";
const STATUS_KEY = "pi-goals";
const WIDGET_KEY = "pi-goals-widget";
const PLANNING_CONTEXT = "pi-goals-planning-context";
const PLAN_REMINDER = "pi-goals-plan-reminder";
const PLAN_DIR = ".pi/plan";
// For static text (the /goals description) where there is no ctx to resolve the session id.
const PLAN_SHAPE = `${PLAN_DIR}/<session_id>-vN.md`;
// Judge toolset: strictly read-only, NO bash -- the judge can never execute or mutate anything, and
// in particular never re-runs a verify command (which may be a 10-hour training job). The agent runs
// verify itself and saves the output as evidence; the judge reads it. Names match pi's tool registry.
const JUDGE_TOOLS = ["read", "grep", "find", "ls"];
const JUDGE_BLOCKED_TOOLS = ["edit", "write"];
const JUDGE_TIMEOUT_MS = 600_000;
// Plan mode is read-only by convention AND a light gate: edit/write are blocked (except the plan
// file, the deliverable). bash stays open — the prompt says don't mutate; guide, not gate (spec D3).
const PLAN_MODE_BLOCKED_TOOLS = ["edit", "write"];
// A plan reminder is only useful after a substantial run of work that has not changed the working
// set. Log and learning entries do not count as progress. Unlike pi-tasks, goals have no dedicated
// progress tool, so this cadence repeats until the working set changes.
const STALE_TURNS = 8;
const AUTO_DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;
const AUTO_MAX_WAKES_WITHOUT_PROGRESS = 2;

// A checkbox line beginning "goal:", for the widget and the "any goals open?" reminder condition.
// Everything else reads the file as prose.
const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*goal:\s*(.*)$/i;
// An indented checkbox line that isn't a goal: a subtask. Only the widget reads these, so the human
// sees the next action and not just the goal -- this file IS the task list.
const SUBTASK_LINE = /^\s+(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*(.*)$/;
// The fold. Above it: the working set that gets re-sent. Below it: durable memory.
const FOLD_LINE = /^##\s+Log\s*$/im;
type GoalStatus = "open" | "active" | "done" | "cancelled";
const CHAR_TO_STATUS: Record<string, GoalStatus> = { " ": "open", "/": "active", x: "done", "-": "cancelled" };

function scanGoals(plan: string): Array<{ status: GoalStatus; subject: string; line: number }> {
	const goals: Array<{ status: GoalStatus; subject: string; line: number }> = [];
	plan.split("\n").forEach((line, i) => {
		const m = GOAL_LINE.exec(line);
		if (m) goals.push({ status: CHAR_TO_STATUS[m[1].toLowerCase()] ?? "open", subject: m[2].trim(), line: i });
	});
	return goals;
}

/** The working set: everything above "## Log". Log, Learnings and Appendix below it are durable
 *  memory -- unlimited, read on demand, pushed back only by a resync. Exported for the unit test. */
export function foldPlan(plan: string): string {
	const m = FOLD_LINE.exec(plan);
	return (m ? plan.slice(0, m.index) : plan).trimEnd();
}

/** Open subtasks under the goal on line `goalLine`, up to the next goal line. */
export function openSubtasks(plan: string, goalLine: number): string[] {
	const lines = plan.split("\n");
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

type Phase = "planning" | "starting" | "working" | null;

interface PlanState {
	/** Distinguishes explicit preferences from the old opt-in defaults. */
	defaultsVersion: 1;
	phase: Phase;
	/** Recovery state is separate from ordinary auto-continue backoff. */
	pausedFrom?: "planning" | "working";
	resumeHash?: string;
	exited?: boolean;
	reviewRequested: boolean;
	questionsWaived: boolean;
	/** Only CompleteGoal records these; a plan checkbox alone is a claim. */
	signedOffGoals: Array<{ subject: string; outcome: "accept" | "inconclusive" }>;
	/** Pre-tracking checkboxes stay historical claims, never automatic reimplementation work. */
	legacyCompletionClaims: string[];
	/** Ready captured its fork, but worker model recovery is still pending (also across reload). */
	modelRecovery: "worker" | null;
	startupError?: string;
	/** Optional model ref for the sign-off judge; unset => current session model, else pi's default. */
	judgeModel: string | null;
	planVersion: number | null;
	/** Interval for continuing active goals when supervision is disabled. */
	autoIntervalMs: number | null;
	autoPaused: boolean;
	/** Real supervisor session, enabled by default and paired through bundled Intercom. */
	stewardEnabled: boolean;
	supervisor: SupervisorBinding | null;
}

export default function piGoalsExtension(pi: ExtensionAPI): void {
	const models = new RoleModels(pi);
	let state: PlanState = {
		defaultsVersion: 1,
		phase: null,
		reviewRequested: false,
		questionsWaived: false,
		signedOffGoals: [],
		legacyCompletionClaims: [],
		modelRecovery: null,
		judgeModel: null,
		planVersion: null,
		autoIntervalMs: AUTO_DEFAULT_INTERVAL_MS,
		autoPaused: false,
		stewardEnabled: true,
		supervisor: null,
	};
	let planningContextPending = false;
	let supervisorOnly = false;
	let operation: AbortController | null = null;
	let reviewAbort = new AbortController();
	let workGeneration = 0;
	let goalAbort = new AbortController();
	let latestContext: ExtensionContext;
	let lastRecoveryError: string | undefined;
	const lifetime = new AbortController();
	// The reminder sees only the working set. A repeated Log line must not look like progress.
	let turnsStale = 0;
	let lastSeenWorkingSet = "";
	let autoTimer: ReturnType<typeof setTimeout> | null = null;
	let autoWakeInFlight = false;
	let autoWakesWithoutProgress = 0;
	let autoLastWorkingSet = "";
	let autoImmediateUsed = false;
	let runStartedBackgroundWork = false;
	// Acknowledge only saved reminders. Automatic compaction skips before_agent_start;
	// defer the refresh until the next natural prompt rather than adding unsaved context.
	let resyncReason: string | null = "New session.";
	let pendingReminder: { id: string; planning: boolean; reason: string | null } | null = null;

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

	function workMessage(ctx: ExtensionContext): string {
		return `Work the goals in ${planPath(ctx)}. Pick an open goal, mark it active ([/]), work its subtasks, and when its discriminator is satisfied fill its evidence: list, then call CompleteGoal with the goal's text. Do not mark a goal [x] before CompleteGoal accepts it. Keep the plan file current as you go.`;
	}

	function clearAutoTimer(): void {
		if (autoTimer !== null) clearTimeout(autoTimer);
		autoTimer = null;
	}

	function refreshSignoffs(plan: string): void {
		const goals = scanGoals(plan);
		const signedOffGoals = state.signedOffGoals.filter(signoff => {
			const matches = goals.filter(goal => goal.subject.toLowerCase() === signoff.subject);
			return matches.length === 1 && matches[0].status === "done";
		});
		const legacyCompletionClaims = state.legacyCompletionClaims.filter(subject => goals.some(goal => goal.subject.toLowerCase() === subject && goal.status === "done"));
		if (signedOffGoals.length !== state.signedOffGoals.length || legacyCompletionClaims.length !== state.legacyCompletionClaims.length) {
			state = { ...state, signedOffGoals, legacyCompletionClaims }; persist();
		}
	}

	function signedOff(subject: string): boolean {
		return state.signedOffGoals.some(signoff => signoff.subject === subject.toLowerCase());
	}

	function pendingGoals(plan: string) {
		refreshSignoffs(plan);
		return scanGoals(plan).filter(goal => goal.status !== "cancelled" && (goal.status !== "done" || !signedOff(goal.subject)));
	}

	function activeGoals(ctx: ExtensionContext): boolean {
		return pendingGoals(readPlan(ctx)).some(goal => !state.legacyCompletionClaims.includes(goal.subject.toLowerCase()));
	}

	function scheduleAutoContinue(ctx: ExtensionContext, delayMs = state.autoIntervalMs): void {
		if (state.stewardEnabled || supervisorOnly || !models.ready) { clearAutoTimer(); return; }
		clearAutoTimer();
		if (delayMs === null || state.phase !== "working" || state.autoIntervalMs === null || state.autoPaused || !activeGoals(ctx)) return;
		autoTimer = setTimeout(() => {
			autoTimer = null;
			if (state.phase !== "working" || state.autoPaused || !ctx.isIdle() || !activeGoals(ctx)) return;
			autoWakeInFlight = true;
			pi.sendUserMessage(
				`<system-reminder>Auto-continue is enabled by the human. Continue the active goal in ${planRel(ctx)}. Work from the open subtasks and observed artifacts. Keep the plan current, including useful Log entries. If you need a human decision, ask one direct question and leave the goal active.</system-reminder>`,
				{ deliverAs: "followUp" },
			);
		}, delayMs);
		autoTimer.unref();
	}

	function settleAuto(ctx: ExtensionContext): void {
		if (state.phase !== "working" || state.autoIntervalMs === null || state.autoPaused || !activeGoals(ctx)) return;
		const workingSet = foldPlan(readPlan(ctx));
		const changed = workingSet !== autoLastWorkingSet;
		if (changed) {
			autoLastWorkingSet = workingSet;
			autoWakesWithoutProgress = 0;
			autoImmediateUsed = false;
		}
		if (autoWakeInFlight) {
			autoWakeInFlight = false;
			if (!changed) autoWakesWithoutProgress++;
			if (autoWakesWithoutProgress >= AUTO_MAX_WAKES_WITHOUT_PROGRESS) {
				state = { ...state, autoPaused: true };
				persist();
				updateWidget(ctx);
				ctx.ui.notify("Goal auto-continue paused; waiting for user after two wakes without working-plan progress.", "warning");
				return;
			}
			scheduleAutoContinue(ctx);
			return;
		}
		if (!runStartedBackgroundWork && !autoImmediateUsed) {
			autoImmediateUsed = true;
			scheduleAutoContinue(ctx, 0);
			return;
		}
		scheduleAutoContinue(ctx);
	}

	function updateWidget(ctx: ExtensionContext): void {
		const tools = pi.getActiveTools().filter(tool => tool !== "RequestPlanReview");
		pi.setActiveTools(state.phase === "planning" && !supervisorOnly ? [...tools, "RequestPlanReview"] : tools);
		if (state.pausedFrom || state.exited) {
			ctx.ui.setStatus(STATUS_KEY, state.exited ? undefined : "goals stopped · /goals resume");
			ctx.ui.setWidget(WIDGET_KEY, state.exited ? undefined : ["Goals stopped by user. Plan and evidence retained."]);
			return;
		}
		if (state.phase === "planning") {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", state.startupError ? "supervisor startup failed" : state.modelRecovery ? models.ready ? "retry Ready" : "worker model paused" : "planning"));
			ctx.ui.setWidget(WIDGET_KEY, state.startupError ? [`pi-goals: ${state.startupError}`, "No work started. /goals stop or /goals exit leaves startup; inspect the supervisor before retrying Ready."] : ["pi-goals: drafting goals"]);
			return;
		}
		if (state.phase === "starting") {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "starting supervisor"));
			ctx.ui.setWidget(WIDGET_KEY, ["pi-goals: starting the supervisor session"]);
			return;
		}
		const plan = readPlan(ctx);
		refreshSignoffs(plan);
		const goals = scanGoals(plan);
		if (goals.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const done = goals.filter((g) => g.status === "done" && signedOff(g.subject)).length;
		const claimed = goals.filter(g => g.status === "done" && !signedOff(g.subject));
		const auto = state.autoPaused ? " · waiting for user" : state.autoIntervalMs === null ? "" : ` · auto ${state.autoIntervalMs / 60_000}m`;
		const steward = (state.stewardEnabled ? " · supervisor" : "") + (claimed.length ? ` · ${claimed.length} claimed, awaiting review` : "");
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◷ ${done}/${goals.length} goals${auto}${steward}`));
		const mark: Record<GoalStatus, string> = { done: "✔", active: "▸", open: "◻", cancelled: "✗" };
		// Only live goals get lines so finished work never pushes current work off screen. The active
		// goal also shows its open subtasks: this file is the task list, so the widget is the task list.
		// No path line: the session id makes it 47 chars, too long to be worth a widget row. The
		// human opens the file from the Ready menu, and every injected reminder still names it.
		const lines: string[] = state.autoPaused ? [ctx.ui.theme.fg("warning", "⏸ waiting for user")] : [];
		lines.push(...claimed.map(g => state.legacyCompletionClaims.includes(g.subject.toLowerCase())
			? `? legacy completion — sign-off not recorded: ${g.subject}`
			: `? claimed complete; awaiting CompleteGoal: ${g.subject}`));
		lines.push(...state.signedOffGoals.filter(s => s.outcome === "inconclusive").map(s => `? accepted inconclusive (not verified): ${s.subject}`));
		for (const g of goals.filter((g) => g.status === "active" || g.status === "open")) {
			lines.push(`${mark[g.status]} ${g.subject}`);
			if (g.status === "active") lines.push(...openSubtasks(plan, g.line).slice(0, 3).map((s) => ctx.ui.theme.fg("muted", `   ◦ ${s}`)));
		}
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	async function stopSupervisor(ctx: ExtensionContext): Promise<void> {
		operation?.abort();
		operation = null;
		if (state.supervisor) {
			try { await supervisor.stop(state.supervisor.id); }
			catch (error) { ctx.ui.notify(`Could not reach the supervisor to stop it: ${String(error)}. Check its pane.`, "warning"); }
		}
		state = { ...state, supervisor: null };
	}

	async function startPlanSupervisor(ctx: ExtensionContext): Promise<void> {
		if (operation) return;
		const controller = new AbortController();
		operation = controller;
		const signal = AbortSignal.any([controller.signal, lifetime.signal]);
		const version = state.planVersion;
		const approvedDraft = planHash(readPlan(ctx));
		const handoff = workMessage(ctx);
		const recoveringWorker = state.modelRecovery === "worker";
		state = { ...state, phase: "starting", startupError: undefined };
		persist(); updateWidget(ctx);
		try {
			// A stopped, never-attached bootstrap cannot be rejoined. A new explicit Ready
			// may replace it; reconnect/resume never create another fork.
			if (state.supervisor) {
				const previous = await supervisor.status(signal);
				if ((previous.binding?.paused || previous.binding?.startupFailure) && previous.role === "none") {
					await supervisor.stop(state.supervisor.id);
					state = { ...state, supervisor: null }; persist();
				}
			}
			if (recoveringWorker) {
				const workerReady = await models.enter("worker", ctx);
				if (signal.aborted || state.planVersion !== version || !state.stewardEnabled) return;
				if (planHash(readPlan(ctx)) !== approvedDraft) throw new Error("The plan changed during model recovery; select Ready again");
				if (!workerReady) { state = { ...state, phase: "planning" }; persist(); updateWidget(ctx); return; }
			}
			const binding = await startSupervisor(pi, supervisor, ctx, planPath(ctx), state.supervisor, supervisor => {
				if (signal.aborted) return;
				state = { ...state, supervisor }; persist();
			}, signal);
			if (signal.aborted || state.planVersion !== version || !state.stewardEnabled) return;
			if (planHash(readPlan(ctx)) !== approvedDraft) { await supervisor.stop(binding.id); state = { ...state, supervisor: null }; throw new Error("The plan changed during initialization; select Ready again"); }
			state = { ...state, supervisor: binding };
			persist(); updateWidget(ctx);
			state = { ...state, modelRecovery: "worker" }; persist();
			const workerReady = await models.enter("worker", ctx);
			if (signal.aborted || state.planVersion !== version || !state.stewardEnabled) return;
			if (!workerReady) {
				state = { ...state, phase: "planning" }; persist(); updateWidget(ctx);
				return; // Keep the attached pairing inactive and the preference target on worker.
			}
			if (signal.aborted || state.planVersion !== version || state.supervisor?.id !== binding.id || !state.stewardEnabled) return;
			if (planHash(readPlan(ctx)) !== approvedDraft) { await supervisor.stop(binding.id); state = { ...state, supervisor: null }; throw new Error("The plan changed during model restoration; select Ready again"); }
			state = { ...state, modelRecovery: null }; persist();
			const peerStatus = await supervisor.status(signal);
			if (peerStatus.binding?.paused) await supervisor.resume(binding.id, approvedDraft, signal);
			else await supervisor.activate(binding.id, signal);
			if (signal.aborted || state.planVersion !== version || state.supervisor?.id !== binding.id || !state.stewardEnabled) return;
			if (planHash(readPlan(ctx)) !== approvedDraft) { await supervisor.stop(binding.id); state = { ...state, supervisor: null }; throw new Error("The plan changed during activation; select Ready again"); }
			state = { ...state, phase: "working" };
			persist(); updateWidget(ctx);
			pi.sendUserMessage(handoff, { deliverAs: "followUp" });
		} catch (error) {
			if (signal.aborted) return;
			state = { ...state, phase: "planning", modelRecovery: null, reviewRequested: false, startupError: String(error) }; persist(); updateWidget(ctx);
			ctx.ui.notify(`Could not initialize the supervisor: ${String(error)}. Use /goals supervisor to inspect startup, or /goals steward off and retry Ready.`, "error");
		} finally {
			if (!lifetime.signal.aborted && state.phase !== "working" && !state.modelRecovery && !state.pausedFrom && !state.exited) {
				await models.enter("planning", ctx);
				if (!state.phase) models.leave();
			}
			if (operation === controller) operation = null;
		}
	}

	function pauseGoals(ctx: ExtensionContext, exit: boolean): void {
		workGeneration++;
		goalAbort.abort(); goalAbort = new AbortController();
		operation?.abort(); operation = null;
		reviewAbort.abort(); reviewAbort = new AbortController();
		clearAutoTimer();
		planningContextPending = false; resyncReason = null; pendingReminder = null;
		if (!supervisorOnly) {
			state = { ...state, pausedFrom: state.pausedFrom ?? (state.phase === "working" ? "working" : state.planVersion !== null ? "planning" : undefined),
				resumeHash: state.resumeHash ?? (state.phase === "working" ? planHash(readPlan(ctx)) : undefined),
				phase: null, reviewRequested: false, modelRecovery: null, autoPaused: true, exited: exit };
			persist(); updateWidget(ctx); models.leave();
		}
	}

	const recoveryHelp = [
		"/goals status — phase, connection, recorded sessions and last failure",
		"/goals stop — stop goal work and supervision; keep plan, evidence and pair",
		"/goals exit — leave goals/planning mode for chat; keep files; no approval",
		"/goals reconnect — reconnect the existing pair; never launch or authorize work",
		"/goals resume — worker only: resume authorized work, or return a draft to planning (Ready still required)",
		"/goals supervisor | worker | zoom — focus the recorded pane",
		"/goals clear — disconnect the plan; keep its file",
		"/goals plan <objective> — start a new draft; free-text objectives still work",
		"Stop/exit do not kill detached processes. A disconnected peer is unconfirmed; stop it in its own pane. Supervisor chat stays inspection-only.",
	].join("\n");

	async function recoveryCommand(arg: string, ctx: ExtensionContext): Promise<boolean> {
		const verb = arg.split(/\s+/)[0];
		if (!["help", "status", "stop", "exit", "reconnect", "resume"].includes(verb)) return false;
		if (arg !== verb) { ctx.ui.notify(`Use /goals ${verb} without arguments. To draft an objective, use /goals plan <objective>.`, "warning"); return true; }
		if (verb === "help") { ctx.ui.notify(recoveryHelp, "info"); return true; }
		if (verb === "stop" || verb === "exit") {
			pauseGoals(ctx, verb === "exit");
			try { supervisor.pause(verb === "exit"); } catch (error) { lastRecoveryError = String(error); ctx.ui.notify(`Stopped locally; peer unconfirmed: ${error}`, "warning"); }
			ctx.abort();
			ctx.ui.notify(verb === "exit" ? "Goals mode exited. Files retained; no work approved. Supervisor sessions remain inspection-only." : "Goals stopped. Use /goals resume in the worker when ready. Detached processes are not killed.", "info");
			return true;
		}
		try {
			if (verb === "status") {
				const status = await supervisor.status();
				const binding = status.binding ?? state.supervisor ?? supervisorBootstrap(ctx)?.binding;
				ctx.ui.notify([`Goals: ${supervisorOnly ? "supervisor" : state.exited ? "ordinary chat (goals exited)" : state.pausedFrom ? "stopped by user" : state.phase ?? "ordinary chat"}.`,
					`Pair: ${status.connected ? "connected" : "disconnected/unconfirmed"}; ${status.activity ?? "inactive"}.`,
					`Worker: ${binding?.workerPane ?? "not recorded"} · ${binding?.workerSession ?? "no paired session"}`,
					`Supervisor: ${binding?.supervisorPane ?? "not recorded"} · ${binding?.supervisorSession ?? "no paired session"}`,
					`Last failure: ${lastRecoveryError ?? status.lastFailure ?? "none recorded in this runtime"}`].join("\n"), "info");
			} else if (verb === "reconnect") {
				await supervisor.reconnect(lifetime.signal);
				ctx.ui.notify("Reconnect handshake sent to the existing pair. No pane created or work authorized. Use /goals status to inspect connectivity.", "info");
			} else if (supervisorOnly) {
				ctx.ui.notify("Resume must be authorized in the worker: /goals worker, then /goals resume. Reconnect alone never starts work.", "info");
			} else if (!state.pausedFrom) {
				ctx.ui.notify("No user-stopped plan to resume. Use /goals status; a draft needs Ready.", "info");
			} else if (state.pausedFrom === "planning" || state.resumeHash !== planHash(readPlan(ctx))) {
				const generation = workGeneration;
				if (!await models.enter("planning", ctx) || generation !== workGeneration || lifetime.signal.aborted) return true;
				state = { ...state, phase: "planning", pausedFrom: undefined, resumeHash: undefined, exited: false, reviewRequested: false };
				planningContextPending = true; persist(); updateWidget(ctx);
				ctx.ui.notify("Draft restored; no work started. Review the plan and request Ready before working.", "info");
			} else {
				if (operation) throw new Error("Recovery already in progress");
				const controller = new AbortController(); operation = controller;
				const signal = AbortSignal.any([controller.signal, lifetime.signal]);
				const generation = workGeneration;
				const hash = state.resumeHash;
				try {
					if (!await models.enter("worker", ctx)) return true;
					signal.throwIfAborted();
					if (state.stewardEnabled) {
						if (!state.supervisor) throw new Error("No recorded pair; return to planning and choose Ready, or turn the steward off explicitly.");
						await supervisor.resume(state.supervisor.id, hash, signal);
					}
					signal.throwIfAborted();
					if (generation !== workGeneration || hash !== planHash(readPlan(ctx))) throw new Error("Plan changed during resume; review before working.");
					state = { ...state, phase: "working", pausedFrom: undefined, resumeHash: undefined, exited: false, autoPaused: false };
					persist(); updateWidget(ctx);
					pi.sendUserMessage(workMessage(ctx), { deliverAs: "followUp" });
				} finally { if (operation === controller) operation = null; }
			}
		} catch (error) { lastRecoveryError = String(error); ctx.ui.notify(`Recovery failed; no new work authorized: ${error}`, "warning"); }
		return true;
	}

	// --- /goals: plan entry and explicit human recovery -----------------------------------------

	pi.registerCommand("goals", {
		description: `Plan mode: draft goals into ${PLAN_SHAPE}, review, then work them. /goals help | status | stop | exit | reconnect | resume | /goals plan <objective> | /goals model current | /goals supervisor | /goals worker | /goals zoom | /goals <objective> | /goals clear | /goals auto [minutes|off] | /goals judge <model> | /goals steward [on|off|status]`,
		getArgumentCompletions: (prefix) => ["help", "status", "stop", "exit", "reconnect", "resume", "supervisor", "worker", "zoom", "clear", "plan", "steward", "auto"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			latestContext = ctx;
			if (await recoveryCommand(args.trim(), ctx)) return;
			if (args.trim() === "model current") {
				if (await models.useCurrent(ctx)) modelRecovered(ctx);
				return;
			}
			if (supervisorOnly) {
				const bootstrap = supervisorBootstrap(ctx)!;
				if (["worker", "supervisor", "zoom"].includes(args.trim())) await focusSupervisor(pi, bootstrap.binding, args.trim() as "worker" | "supervisor" | "zoom");
				else ctx.ui.notify("This is the supervisor session. Use /goals worker to return to the plan's worker.", "info");
				return;
			}
			const explicitPlan = args.trim() === "plan" || args.trim().startsWith("plan ");
			const arg = explicitPlan ? args.trim().slice(4).trim() : args.trim();
			if (!explicitPlan && ["supervisor", "worker", "zoom"].includes(arg)) {
				try {
					if (!state.supervisor) throw new Error("Select Ready with the steward enabled first");
					await focusSupervisor(pi, state.supervisor, arg as "supervisor" | "worker" | "zoom");
				} catch (error) { ctx.ui.notify(String(error), "warning"); }
				return;
			}
			if (!explicitPlan && (arg === "clear" || arg === "--clear")) {
				if (state.planVersion === null) {
					ctx.ui.notify("No active plan to disconnect.", "info");
					return;
				}
				const currentPlan = planRel(ctx);
				await stopSupervisor(ctx);
				clearAutoTimer();
				state = {
					...state,
					phase: null,
					pausedFrom: undefined, resumeHash: undefined, exited: false,
					modelRecovery: null,
					planVersion: null,
					autoPaused: false,
					supervisor: null,
				};
				persist();
				updateWidget(ctx);
				models.leave();
				ctx.ui.notify(`Disconnected from ${currentPlan}; the file remains on disk.`, "info");
				return;
			}
			if (!explicitPlan && (arg === "auto" || arg.startsWith("auto ") || arg === "--auto" || arg.startsWith("--auto "))) {
				const command = arg.startsWith("--") ? "--auto" : "auto";
				const value = arg.slice(command.length).trim();
				if (value === "off") {
					clearAutoTimer();
					state = { ...state, autoIntervalMs: null, autoPaused: false };
					persist();
					updateWidget(ctx);
					ctx.ui.notify("Goal auto-continue disabled.", "info");
					return;
				}
				if (state.phase !== "working") {
					ctx.ui.notify("Approve a plan with Ready before enabling auto-continue.", "warning");
					return;
				}
				const minutes = value ? Number(value) : AUTO_DEFAULT_INTERVAL_MS / 60_000;
				if (!Number.isInteger(minutes) || minutes < 1) {
					ctx.ui.notify("Use /goals auto [whole minutes], or /goals auto off.", "warning");
					return;
				}
				autoWakeInFlight = false;
				autoWakesWithoutProgress = 0;
				autoLastWorkingSet = foldPlan(readPlan(ctx));
				state = { ...state, autoIntervalMs: minutes * 60_000, autoPaused: false };
				persist();
				updateWidget(ctx);
				scheduleAutoContinue(ctx);
				ctx.ui.notify(`Goal auto-continue enabled every ${minutes}m.`, "info");
				return;
			}
			if (!explicitPlan && (arg === "steward" || arg.startsWith("steward "))) {
				const value = arg.slice("steward".length).trim() || "status";
				if (value === "status") {
					try {
						const status = await supervisor.status();
						ctx.ui.notify(`Plan supervisor: ${!state.stewardEnabled ? "disabled" : status.connected ? "connected" : "enabled, not connected; starts at Ready"}.`, "info");
					} catch (error) { ctx.ui.notify(`Plan supervisor: ${state.stewardEnabled ? "enabled" : "disabled"}; ${String(error)}`, "warning"); }
					return;
				}
				if (value !== "on" && value !== "off") {
					ctx.ui.notify("Use /goals steward on, off, or status.", "warning");
					return;
				}
				if (value === "on" && state.phase === "working" && !state.supervisor) {
					ctx.ui.notify("Enable the persistent steward before selecting Ready so it can retain the planning context.", "warning");
					return;
				}
				if (value === "off") await stopSupervisor(ctx);
				state = {
					...state,
					stewardEnabled: value === "on",
					...(value === "off" ? {
						phase: state.phase === "starting" ? "planning" : state.phase,
						supervisor: null,
					} : {}),
				};
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`Persistent plan steward ${value === "on" ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (!explicitPlan && (arg === "judge" || arg.startsWith("judge ") || arg === "--judge" || arg.startsWith("--judge "))) {
				const command = arg.startsWith("--") ? "--judge" : "judge";
				const ref = arg.slice(command.length).trim();
				state = { ...state, judgeModel: ref || null };
				persist();
				ctx.ui.notify(ref ? `Sign-off judge model set to ${ref}` : "Sign-off judge reset to the session model", "info");
				return;
			}
			if (!explicitPlan && (/^(?:--|\/)/.test(arg) || /^(?:connect|disconnect|pause|quit|restart|reset|resum|reconect|stpo|stats)(?:\s|$)/i.test(arg))) {
				ctx.ui.notify("Unknown recovery command. Use /goals help; for an objective use /goals plan <objective>.", "warning"); return;
			}
			await stopSupervisor(ctx);
			if (!await models.enter("planning", ctx)) return;
			state = {
				...state,
				phase: "planning",
				startupError: undefined,
				pausedFrom: undefined, resumeHash: undefined, exited: false,
				modelRecovery: null,
				reviewRequested: false,
				questionsWaived: waivesAlignment(arg),
				signedOffGoals: [],
				legacyCompletionClaims: [],
				planVersion: nextVersion(ctx),
				supervisor: null,
			};
			planningContextPending = true;
			resyncReason = null;
			pendingReminder = null;
			writePlan(ctx, "");
			persist();
			updateWidget(ctx);
			// The drafting rules are sent ONCE, with the seed. v2 re-injected them every turn, which is
			// why plan mode read as never-ending: every reply re-armed it. They come back only on a
			// resync (session start / compaction), when the model has genuinely lost them.
			const seed = arg
				? `We're in plan mode. Objective: ${arg}\n\n${planDrafting}\n\n${alignmentPolicy(state.questionsWaived)}\n\nWrite the plan to ${planPath(ctx)}.`
				: `We're in plan mode. Tell me what you want to plan.\n\n${planDrafting}\n\n${alignmentPolicy(state.questionsWaived)}\n\nWrite the plan to ${planPath(ctx)}.`;
			pi.sendUserMessage(seed, { deliverAs: "followUp" });
		},
	});

	// --- hooks --------------------------------------------------------------------------------------

	/** Refresh at a natural prompt, retaining due state until the message is saved. */
	function dueReminder(ctx: ExtensionContext, plan: string): string | null {
		if (state.phase !== "working" || state.pausedFrom || state.exited) return null;
		if (!plan.trim()) return null;
		if (resyncReason) return resync(plan, planRel(ctx), resyncReason);
		if (turnsStale < STALE_TURNS) return null;
		const goals = scanGoals(plan);
		if (goals.length === 0) {
			// Non-empty plan but no recognizable goal line: the harness would go silently inert (no
			// widget, no injection, no reminders). Say so instead -- cooperative but confused.
			return `<system-reminder>\n${planRel(ctx)} exists but has no goal line pi-goals recognizes. A goal is a checkbox list line starting "goal:", e.g. "1. [ ] goal: <imperative>" ([ ] open, [/] active, [x] done, [-] cancelled). Reformat it if it's meant to be the plan.\n</system-reminder>`;
		}
		if (!pendingGoals(plan).length) return null;
		return reminder(foldPlan(plan), planRel(ctx));
	}

	function confirmReminder(ctx: ExtensionContext): void {
		if (!pendingReminder) return;
		const id = pendingReminder.id;
		const saved = ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && (entry.details as { reminderId?: string } | undefined)?.reminderId === id);
		if (!saved) return;
		if (pendingReminder.planning) planningContextPending = false;
		else {
			if (resyncReason === pendingReminder.reason) resyncReason = null;
			turnsStale = 0;
		}
		pendingReminder = null;
	}

	// Pi persists this returned message before building model context. Failed delivery
	// leaves the reminder due; the next natural prompt rereads the current plan.
	pi.on("before_agent_start", async (_event, ctx) => {
		confirmReminder(ctx);
		if (supervisorOnly || state.pausedFrom || state.exited) return;
		const planning = state.phase === "planning" || state.phase === "starting";
		const content = planning ? planningContextPending ? planningState(planPath(ctx), state.questionsWaived) : null : dueReminder(ctx, readPlan(ctx));
		if (!content) return;
		const id = randomUUID();
		pendingReminder = { id, planning, reason: resyncReason };
		return { message: { customType: planning ? PLANNING_CONTEXT : PLAN_REMINDER, content, display: false, details: { reminderId: id } } };
	});

	// Keep the existing planning filter, but never add ephemeral plan reminders.
	// Planning-filter and supervisor replay compatibility are separate work.
	pi.on("context", async (event, ctx) => {
		confirmReminder(ctx);
		if (state.phase === "planning" || state.phase === "starting") return;
		return { messages: event.messages.filter(message => (message as { customType?: string }).customType !== PLANNING_CONTEXT) };
	});

	// PI: Human plan-mode replies are durable evidence of the interview, not model summaries.
	pi.on("input", async (event, ctx) => {
		if ((state.pausedFrom || state.exited) && event.source === "extension" &&
			(event.text.startsWith("Work the goals in ") || event.text.startsWith("<system-reminder>Auto-continue") || event.text.startsWith("[supervisor]") || event.text === discussPlan || event.text.startsWith("We're in plan mode."))) return { action: "handled" as const };
		if (!models.ready) { ctx.ui.notify("Role model unavailable. Select a different model with /model, explicitly use the current one with /goals model current, or configure the saved model and reload.", "error"); return { action: "handled" as const }; }
		if (event.source !== "extension") {
			clearAutoTimer();
			autoImmediateUsed = false;
			if (state.autoPaused && !state.pausedFrom && !state.exited) {
				state = { ...state, autoPaused: false };
				persist();
				updateWidget(ctx);
			}
		}
		if ((state.phase === "planning" || state.phase === "starting") && event.source !== "extension") writePlan(ctx, appendInterview(readPlan(ctx), event.text));
	});

	// The staleness clock sees only the working set. Log updates are durable evidence, not progress.
	pi.on("turn_end", async (_event, ctx) => {
		confirmReminder(ctx);
		const workingSet = foldPlan(readPlan(ctx));
		if (workingSet === lastSeenWorkingSet) {
			turnsStale++;
			return;
		}
		lastSeenWorkingSet = workingSet;
		turnsStale = 0;
		updateWidget(ctx);
	});

	pi.on("agent_start", async () => {
		runStartedBackgroundWork = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (state.phase === "working" && (event.toolName === "subagent" || (event.toolName === "process" && (event.input as { action?: string }).action === "start"))) {
			runStartedBackgroundWork = true;
		}
		if (!models.ready) return { block: true, reason: "Role model unavailable; select with /model before continuing." };
		if (state.phase !== "planning" && state.phase !== "starting") return;
		if (PLAN_MODE_BLOCKED_TOOLS.includes(event.toolName)) {
			const target = (event.input as { path?: string }).path;
			if (target && resolve(ctx.cwd, target) === resolve(planPath(ctx))) return;
			return { block: true, reason: `Planning is read-only: only ${planRel(ctx)} may be written. Agree the plan, then choose Ready.` };
		}
		if (event.toolName === "bash" && !isPlanningReadOnlyCommand(String((event.input as { command?: string }).command))) {
			return { block: true, reason: "Planning is read-only: inspect facts without writes or pipes, then put the change in the plan." };
		}
	});

	// A compaction loses context, so restore either the planning snapshot or the working plan once.
	pi.on("session_compact", async (_event, ctx) => {
		confirmReminder(ctx);
		if (state.phase === "planning" || state.phase === "starting") planningContextPending = true;
		else resyncReason = "The session was just compacted.";
	});

	// PI: Print after Pi settles. agent_end is still streaming, so its message queues behind the menu.
	let reviewOpen = false;
	async function reviewPlan(ctx: ExtensionContext): Promise<void> {
		if (reviewOpen || lifetime.signal.aborted) return;
		reviewOpen = true;
		try { await offerPlanReview(ctx); } finally { reviewOpen = false; }
	}
	async function offerPlanReview(ctx: ExtensionContext): Promise<void> {
		if (state.phase === "working") {
			settleAuto(ctx);
			return;
		}
		if (state.phase !== "planning" || !state.reviewRequested || !ctx.hasUI) return;
		let printed = "";
		while (true) {
			const plan = readPlan(ctx);
			if (scanGoals(plan).length === 0) {
				if (plan.trim()) ctx.ui.notify(`The plan has no goal line. Revise ${planRel(ctx)} to add one.`, "warning");
				return;
			}
			if (plan !== printed) {
				printed = plan;
				pi.sendMessage({ customType: "plan", content: plan, display: true });
			}
			const version = state.planVersion;
			const generation = workGeneration;
			const choice = await ctx.ui.select(`Plan drafted in ${planRel(ctx)}.`, ["Ready", "Discuss", "Edit", "Cancel"], { signal: reviewAbort.signal });
			if (state.phase !== "planning" || generation !== workGeneration || version !== state.planVersion || lifetime.signal.aborted) return;
			if (choice === "Discuss" || choice === undefined) {
				if (state.modelRecovery && !await models.enter("planning", ctx)) return;
				state = { ...state, modelRecovery: null };
				state = { ...state, reviewRequested: false }; persist();
				planningContextPending = true;
				pi.sendUserMessage(discussPlan, { deliverAs: "followUp" });
				return;
			}
			if (choice === "Edit") {
				const edited = await ctx.ui.editor("Edit the plan", plan);
				if (generation !== workGeneration || version !== state.planVersion || state.phase !== "planning") return;
				if (edited !== undefined && edited !== plan) writePlan(ctx, edited);
				continue;
			}
			if (choice === "Cancel") {
				await stopSupervisor(ctx);
				rmSync(planPath(ctx), { force: true });
				state = {
					...state,
					phase: null,
					modelRecovery: null,
					planVersion: null,
					supervisor: null,
				};
				persist();
				updateWidget(ctx);
				models.leave();
				ctx.ui.notify("Plan discarded.", "info");
				return;
			}
			if (choice !== "Ready") return;
			if (state.stewardEnabled) {
				await startPlanSupervisor(ctx);
				return;
			}
			const approvedDraft = planHash(readPlan(ctx));
			state = { ...state, modelRecovery: "worker" }; persist();
			const workerReady = await models.enter("worker", ctx);
			if (lifetime.signal.aborted) return;
			if (state.phase !== "planning" || state.planVersion !== version || planHash(readPlan(ctx)) !== approvedDraft) {
				await models.enter("planning", ctx);
				if (!state.phase) models.leave();
				ctx.ui.notify("Plan changed while restoring the worker model; review it again before Ready.", "warning");
				return;
			}
			if (!workerReady) return;
			state = { ...state, phase: "working", modelRecovery: null };
			persist();
			updateWidget(ctx);
			pi.sendUserMessage(workMessage(ctx), { deliverAs: "followUp" });
			return;
		}
	}
	pi.on("agent_settled", async (_event, ctx) => reviewPlan(ctx));

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		const bootstrap = supervisorBootstrap(ctx);
		if (bootstrap) {
			supervisorOnly = true;
			pi.setActiveTools(pi.getActiveTools().filter(tool => tool !== "CompleteGoal" && tool !== "RequestPlanReview"));
			if (await models.enter("supervisor", ctx)) initializeSupervisor(supervisor, ctx, bootstrap, lifetime.signal);
			return;
		}
		const last = ctx.sessionManager
			.getBranch()
			.filter((e: { type?: string; customType?: string }) => e.type === "custom" && e.customType === STATE)
			.pop() as { data?: PlanState } | undefined;
		// Upgrade cleared/unused legacy sessions, but never attach supervision mid-plan.
		const saved = last?.data;
		const useNewDefaults = saved?.defaultsVersion !== 1 && saved?.planVersion == null;
		state = {
			defaultsVersion: 1,
			phase: saved?.pausedFrom || saved?.exited ? null : saved?.phase === "working" ? "working" : saved?.phase ? "planning" : null,
			pausedFrom: saved?.pausedFrom, resumeHash: saved?.resumeHash, exited: saved?.exited,
			reviewRequested: last?.data?.reviewRequested ?? true,
			questionsWaived: last?.data?.questionsWaived ?? false,
			signedOffGoals: last?.data?.signedOffGoals ?? [],
			legacyCompletionClaims: last?.data?.legacyCompletionClaims ?? [],
			modelRecovery: last?.data?.modelRecovery ?? null,
			startupError: saved?.startupError ?? (saved?.phase === "starting" ? "Supervisor startup interrupted by reload. Inspect its pane before retrying Ready." : undefined),
			judgeModel: last?.data?.judgeModel ?? null,
			planVersion: last?.data?.planVersion ?? null,
			autoIntervalMs: useNewDefaults || saved?.autoIntervalMs === undefined ? AUTO_DEFAULT_INTERVAL_MS : saved.autoIntervalMs,
			autoPaused: useNewDefaults ? false : saved?.autoPaused ?? false,
			stewardEnabled: useNewDefaults ? true : saved?.stewardEnabled ?? true,
			supervisor: last?.data?.supervisor ?? null,
		};
		if (saved && saved.signedOffGoals === undefined) {
			state.legacyCompletionClaims = scanGoals(readPlan(ctx)).filter(goal => goal.status === "done").map(goal => goal.subject.toLowerCase());
			persist();
		}
		lastSeenWorkingSet = foldPlan(readPlan(ctx));
		autoLastWorkingSet = lastSeenWorkingSet;
		planningContextPending = state.phase === "planning" || state.phase === "starting";
		resyncReason = state.phase === "working" ? "New session." : null;
		pendingReminder = null;
		updateWidget(ctx);
		if (state.phase && !await models.enter(state.phase === "working" || state.modelRecovery ? "worker" : "planning", ctx)) return;
		scheduleAutoContinue(ctx);
	});

	pi.on("session_shutdown", async () => {
		lifetime.abort();
		goalAbort.abort(); reviewAbort.abort();
		operation?.abort();
		clearAutoTimer();
	});

	pi.registerTool({
		name: "RequestPlanReview",
		label: "Review plan",
		description: "Planning only: after material unresolved questions have been answered (no fixed quota), and the final plan is ready, show the human Ready / Discuss / Edit / Cancel. Do not call while waiting for answers. Call again after discussion is finished, even for an unchanged draft. This does not approve or start work.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			if (supervisorOnly || state.phase !== "planning") return result("Only a planning session can request plan review.", true);
			if (!scanGoals(readPlan(ctx)).length) return result("Draft concrete goals before requesting review.", true);
			state = { ...state, reviewRequested: true }; persist();
			return { ...result("Plan review requested. End this response and wait for the human's choice."), terminate: true };
		},
	});

	// --- the one blessed tool: CompleteGoal ---------------------------------------------------------

	pi.registerTool({
		name: "CompleteGoal",
		label: "Goal signoff",
		description: completeGoalDescription,
		parameters: Type.Object({
			goal: Type.String({ description: completeGoalParamDescription }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			signal = AbortSignal.any([lifetime.signal, goalAbort.signal, ...(signal ? [signal] : [])]);
			if (state.pausedFrom || state.exited) return result("Goals stopped. Resume explicitly before signing off.", true);
			const generation = workGeneration;
			if (state.phase === "planning" || state.phase === "starting") return result("Planning is not approved. Wait for the steward or choose Ready before signing off a goal.", true);
			let plan = readPlan(ctx);
			if (!plan.trim()) return result(`No plan file at ${planRel(ctx)}. Run /goals to draft one.`, true);

			if (supervisorOnly) throw new Error("Only the worker can complete its plan goals");
			if (signal?.aborted || lifetime.signal.aborted) return result("Sign-off aborted.", true);
			// A model may tick before calling this tool. The submitted goal is still under review;
			// a rejection or cancellation must not leave that premature success visible.
			const submitted = scanGoals(plan).filter(goal => goal.subject.toLowerCase() === params.goal.trim().toLowerCase());
			if (submitted.length !== 1) return result("CompleteGoal requires one unique exact goal subject (ignoring case and surrounding whitespace). Copy the text after 'goal:' from the current plan; give duplicate goals distinct subjects before retrying. No sign-off recorded.", true);
			refreshSignoffs(plan);
			if (submitted[0].status === "done") {
				const lines = plan.split("\n");
				lines[submitted[0].line] = lines[submitted[0].line].replace(/\[[xX]\]/, "[/]");
				plan = lines.join("\n");
				writePlan(ctx, plan);
				updateWidget(ctx);
			}
			if (state.stewardEnabled) {
				if (!state.supervisor) return result("No supervisor is paired. Retry Ready or use /goals steward off.", true);
				const bindingId = state.supervisor.id;
				const hash = planHash(plan);
				try {
					onUpdate?.({ content: [{ type: "text", text: "Supervisor checking trajectory and scope…" }], details: {} });
					const decision = await supervisor.review(bindingId, params.goal, hash, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]));
					if (state.supervisor?.id !== bindingId || planHash(readPlan(ctx)) !== hash || decision.bindingId !== bindingId || decision.goal !== params.goal || decision.planHash !== hash) return result("Plan or pairing changed during goal review; retry.", true);
					if (decision.decision !== "approve") return result(`Supervisor: ${decision.decision}. ${decision.reason}`, true);
				} catch (error) { return result(`Supervisor review failed: ${String(error)}`, true); }
			}

			if (generation !== workGeneration) return result("Sign-off stopped; no goal signed off.", true);
			const reviewedPlanHash = planHash(plan);
			const reviewedVersion = state.planVersion;
			const reviewedPairing = state.supervisor?.id;
			const judgeModel = state.judgeModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
			onUpdate?.({ content: [{ type: "text", text: `Read-only judge (${judgeModel ?? "pi default"}) inspecting: ${params.goal}` }], details: {} });
			// decideSignOff runs the judge and derives the outcome + the one log line. judgeModel is never
			// checked pre-emptively: null just means pi's configured default runs (buildJudgeArgs omits
			// --model), so accepted_inconclusive always means "the judge ran but failed", never "no model".
			let judgeRaw: JudgeResult | null = null;
			const outcome = await decideSignOff({ goal: params.goal, plan, planRel: planRel(ctx), judgeModel }, signal, async (task) => {
				judgeRaw = await runJudge(task, judgeModel, ctx.cwd, signal);
				return judgeRaw;
			});
			// Persist the judge's full transcript so "did the judge really re-run verify?" is answerable
			// after the fact (dogfood finding: with only the one log line, an accept is unauditable).
			let transcriptNote = "";
			if (judgeRaw !== null) {
				const raw: JudgeResult = judgeRaw;
				mkdirSync(join(ctx.cwd, ".pi", "judge"), { recursive: true });
				const rel = `.pi/judge/${stamp().replace(/[: ]/g, "-")}-${process.hrtime.bigint()}.md`;
				writeFileSync(join(ctx.cwd, rel), `goal: ${params.goal}\nmodel: ${judgeModel ?? "pi default"}\nerror: ${raw.error ?? "none"}\n\n${raw.output}\n`);
				transcriptNote = ` (${rel})`;
			}
			if (signal?.aborted || lifetime.signal.aborted || generation !== workGeneration) return result("Sign-off aborted; no goal was signed off.", true);
			if (state.planVersion !== reviewedVersion || state.supervisor?.id !== reviewedPairing || planHash(readPlan(ctx)) !== reviewedPlanHash) return result("The plan or supervisor changed during evidence review; no goal was signed off. Retry.", true);
			if (outcome.logEntry) {
				let updated = readPlan(ctx);
				let tickNote = "";
				const signedOutcome = outcome.status === "accept" || outcome.status === "inconclusive" ? outcome.status : undefined;
				if (signedOutcome) {
					const ticked = tickGoal(updated, params.goal);
					if (!ticked) return result("Goal identity changed; retry with one unique exact goal subject. No sign-off recorded.", true);
					updated = ticked;
					tickNote = `\n\nGoal ticked [x] in ${planRel(ctx)}.`;
				}
				writePlan(ctx, appendLog(updated, `${stamp()} ${outcome.logEntry}${transcriptNote}`));
				if (signedOutcome) {
					const subject = submitted[0].subject.toLowerCase();
					state = { ...state, signedOffGoals: [...state.signedOffGoals.filter(s => s.subject !== subject), { subject, outcome: signedOutcome }] };
					persist();
				}
				updateWidget(ctx);
				return result(outcome.resultText + tickNote, outcome.isError);
			}
			return result(outcome.resultText, outcome.isError);
		},
	});
	// Registered after role restoration, so rejoin cannot start a supervisor turn on the worker model.
	const supervisor = supervise(pi, () => models.ready, (plan) => {
		const pending = pendingGoals(plan);
		const claims = pending.filter(goal => goal.status === "done");
		const inconclusive = state.signedOffGoals.filter(signoff => signoff.outcome === "inconclusive");
		return {
			completion: { planHash: planHash(plan), total: scanGoals(plan).length, pending: pending.length, inconclusive: inconclusive.length },
			summary: `CompleteGoal records: ${state.signedOffGoals.length - inconclusive.length} conclusive, ${inconclusive.length} accepted inconclusive (not verified); ${pending.length} goals await sign-off.\nUnsigned completion claims: ${claims.map(goal => goal.subject).join(", ") || "none"}. Legacy completions without tracking: ${state.legacyCompletionClaims.join(", ") || "none"}; preserve their history and use CompleteGoal re-review if needed, not automatic reimplementation. A checkbox is not proof; inspect the current plan and artifacts.`,
		};
	}, exit => { if (latestContext) pauseGoals(latestContext, exit); });
	function modelRecovered(ctx: ExtensionContext): void {
		if (supervisorOnly) {
			const bootstrap = supervisorBootstrap(ctx);
			if (bootstrap) initializeSupervisor(supervisor, ctx, bootstrap, lifetime.signal);
		} else if (state.modelRecovery && models.ready) {
			// Do not await a UI dialog inside Pi's model_select dispatch.
			setImmediate(() => { void reviewPlan(ctx).catch(error => ctx.ui.notify(String(error), "error")); });
		}
	}
	pi.on("model_select", (event, ctx) => {
		if (models.ready && !models.restoring && event.source !== "restore") modelRecovered(ctx);
	});
}

// --- helpers (module scope) --------------------------------------------------------------------

function result(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function isPlanningReadOnlyCommand(command: string): boolean {
	if (/[|>]/.test(command)) return false;
	return command.split(/&&|;/).every((part) => /^(?:cd\b|pwd|ls\b|git\s+(?:status|log|diff|show|branch)\b|rg\b|grep\b|find\b|head\b|tail\b|wc\b|stat\b|test\b)\b/.test(part.trim()));
}

/** Local time, not UTC: agents freehand-stamp their manual ## Log lines from the local clock they
 *  see, so a UTC tool stamp made the trail read as two different afternoons (dogfood finding). */
function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** A judge run's result: stdout output, plus an error string when the subprocess failed/timed out. */
export interface JudgeResult {
	output: string;
	error?: string;
}

/** Inputs to a sign-off decision. judgeModel is null when no explicit/session model is set. */
export interface SignOffInput {
	goal: string;
	plan: string;
	/** The session's plan file, relative to cwd; the judge prompt names it. */
	planRel: string;
	judgeModel: string | null;
}

/** The outcome of a sign-off: the reply text, whether it's a hard error, and the one ## Log line to
 *  append (null when nothing should be written, e.g. aborted before any verdict). */
export interface SignOffOutcome {
	status: "accept" | "reject" | "inconclusive" | "aborted";
	resultText: string;
	isError: boolean;
	logEntry: string | null;
}

/** Run the judge and decide accept / reject / accepted_inconclusive. Pure aside from the injected
 *  judge runner, so the unit test can lock the fail-forward invariant: judgeModel is NEVER checked
 *  here, so a null model still reaches runJudge (pi's configured default runs it), and the only
 *  producers of accepted_inconclusive are the judge-error and no-VERDICT paths -- i.e. "the judge
 *  ran but failed", never "no model". The execute() wrapper does the plan-file write + widget.
 *  Exported for the unit test that locks this invariant. */
export async function decideSignOff(
	input: SignOffInput,
	signal: AbortSignal | undefined,
	runJudgeFn: (task: string) => Promise<JudgeResult>,
): Promise<SignOffOutcome> {
	const task = judgeUser({ goal: input.goal, plan: input.plan, planPath: input.planRel });
	const judge = await runJudgeFn(task);

	if (signal?.aborted) return { status: "aborted", resultText: "Sign-off aborted.", isError: true, logEntry: null };

	// Judge ran but failed/errored/timed out: fail forward, say so in the log.
	if (judge.error) {
		const partial = judge.output ? `\n\npartial judge output:\n${judge.output}` : "";
		return {
			status: "inconclusive",
			resultText: `Judge ran but failed (${judge.error}). Accepted inconclusive — logged; this is not verified completion.${partial}`,
			isError: false,
			logEntry: `signed off "${input.goal}" (judge inconclusive: ran but failed: ${oneLine(judge.error)})`,
		};
	}

	const verdictLine = judge.output.split("\n").find((l) => /^\s*VERDICT\s*:/i.test(l)) ?? "";
	const verdict = /^\s*VERDICT\s*:\s*(accept|reject)\s*$/i.exec(verdictLine)?.[1]?.toLowerCase();
	const reasoning = judge.output.length > 2000 ? `...\n${judge.output.slice(-2000)}` : judge.output;

	if (verdict === "accept") {
		const beforeVerdict = judge.output.slice(0, judge.output.indexOf(verdictLine));
		const heading = /^#{0,6}[ \t]*(?:\*\*)?checks(?:\*\*)?:[ \t]*$/im.exec(beforeVerdict);
		const checksBody = heading
			? beforeVerdict.slice(heading.index + heading[0].length).split(/^#{1,6}[ \t]+/m, 1)[0]
			: "";
		const checks = /^[ \t]*(?:[-*]|\d+[.)])[ \t]+\S.*$/m.test(checksBody);
		if (!checks) {
			return {
				status: "reject",
				resultText: `Sign-off REJECTED. Missing:\nchecked-artifact list before VERDICT: accept\n\n--- judge ---\n${reasoning}`,
				isError: true,
				logEntry: `reject "${input.goal}": judge accept had no checked-artifact list`,
			};
		}
		return {
			status: "accept",
			resultText: `Sign-off ACCEPTED (log line appended).\n\n--- judge ---\n${reasoning}`,
			isError: false,
			logEntry: `signed off "${input.goal}" (judge accept)`,
		};
	}
	if (verdict === "reject") {
		const missing = judge.output.match(/missing\s*:\s*([\s\S]*)$/i)?.[1].trim() || judge.output.slice(-500);
		return {
			status: "reject",
			resultText: `Sign-off REJECTED. Missing:\n${missing}\n\n--- judge ---\n${reasoning}`,
			isError: true,
			logEntry: `reject "${input.goal}": ${oneLine(missing)}`,
		};
	}
	// No VERDICT line: same fail-forward as a judge error -- the judge ran but didn't answer.
	return {
		status: "inconclusive",
		resultText: `Judge returned no VERDICT line. Accepted inconclusive — logged; this is not verified completion.\n\n--- judge ---\n${reasoning || "(no output)"}`,
		isError: false,
		logEntry: `signed off "${input.goal}" (judge inconclusive: no VERDICT line)`,
	};
}

/** Tick the goal line whose subject exactly matches `goal` (trimmed, case-insensitive) to [x].
 *  Null when there is no unique exact match (wording drift / duplicates). CompleteGoal refuses
 *  ambiguous identity before review; this helper never chooses a different goal. */
export function tickGoal(plan: string, goal: string): string | null {
	const lines = plan.split("\n");
	const want = goal.trim().toLowerCase();
	const hits = lines.flatMap((l, i) => (GOAL_LINE.exec(l)?.[2].trim().toLowerCase() === want ? [i] : []));
	if (hits.length !== 1) return null;
	lines[hits[0]] = lines[hits[0]].replace(/\[[ xX/-]\]/, "[x]");
	return lines.join("\n");
}

/** Append one line under ## Log (creating the section at EOF if absent). */
export function appendLog(text: string, entry: string): string {
	const lines = text.split("\n");
	const line = `- ${entry}`;
	const header = lines.findIndex((l) => /^##\s+Log\s*$/i.test(l));
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

/** Build the pi argv for the read-only judge. `--model` is omitted when no explicit/session model is
 *  set, so pi falls back to its configured default — the judge always runs. `--no-extensions` keeps
 *  the judge minimal and immune to a broken third-party extension taking down every sign-off.
 *  Exported for the unit test that locks these invariants. */
export function buildJudgeArgs(judgeModel: string | null): string[] {
	const args = ["-p", "--no-session", "--no-extensions"];
	if (judgeModel) args.push("--model", judgeModel);
	args.push("--tools", JUDGE_TOOLS.join(","), "--exclude-tools", JUDGE_BLOCKED_TOOLS.join(","), "--append-system-prompt", judgeSystem);
	return args;
}

/** Locate the pi binary the same way the oracle extension does, so spawning works under bun or node. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** Spawn the read-only judge subprocess (plain `pi -p`: stdout is the final response text). */
async function runJudge(
	task: string,
	judgeModel: string | null,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<JudgeResult> {
	const args = buildJudgeArgs(judgeModel);
	args.push(task);
	const inv = getPiInvocation(args);
	// Runs in-place against this checkout; pi --no-session does not clone into the parent
	// (proven by scripts/check-judge-footprint.sh).
	return new Promise((resolvePromise) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		const done = (r: { output: string; error?: string }) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolvePromise(r);
			}
		};
		const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], signal });
		const timer = setTimeout(() => {
			proc.kill();
			done({ output: stdout.trim(), error: `judge timed out after ${JUDGE_TIMEOUT_MS / 1000}s` });
		}, JUDGE_TIMEOUT_MS);
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			if ((code ?? 0) !== 0) done({ output: stdout.trim(), error: stderr.trim() || `judge subprocess exited ${code ?? 1}` });
			else done({ output: stdout.trim() });
		});
		proc.on("error", (e) => done({ output: stdout.trim(), error: `judge subprocess failed: ${e.message}` }));
	});
}
