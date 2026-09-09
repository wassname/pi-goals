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
 *                that gets the whole plan file plus the claimed goal, finds the goal itself
 *                (tolerates wording drift), checks the evidence (including the agent's saved
 *                verify output) against the repo, and returns VERDICT: accept|reject
 *
 * The judge subsumes what v1 did in code: goal matching (no findGoal), evidence validation (a
 * placeholder gets rejected in words), and format reading. The extension's only
 * writes are the sign-off: append a log line to ## Log (the audit trail) and tick the goal [x] when
 * an exact goal line matches (on drift the agent ticks, and the result says so). A hand-tick
 * without a matching tool-written log line is visible in the diff either way.
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
import { focusSupervisor, initializeSupervisor, planHash, type SupervisorBinding, type SupervisorDecision, startSupervisor, supervisorBootstrap, supervisorRequest } from "./supervisor.js";

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
	reviewRequested: boolean;
	questionsWaived: boolean;
	/** Ready captured its fork, but worker model recovery is still pending (also across reload). */
	modelRecovery: "worker" | null;
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
	// Drained only after a saved reminder is observed. Auto-compaction skips before_agent_start:
	// defer refresh until the next natural prompt rather than injecting unsaved context or a turn.
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
		return `Work the goals in ${planPath(ctx)}. Pick an open goal, mark it active ([/]), work its subtasks, and when its discriminator is satisfied fill its evidence: list, then call CompleteGoal with the goal's text. Keep the plan file current as you go.`;
	}

	function clearAutoTimer(): void {
		if (autoTimer !== null) clearTimeout(autoTimer);
		autoTimer = null;
	}

	function activeGoals(ctx: ExtensionContext): boolean {
		return scanGoals(readPlan(ctx)).some((goal) => goal.status === "active" || goal.status === "open");
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
		if (state.phase === "planning") {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", state.modelRecovery ? models.ready ? "retry Ready" : "worker model paused" : "planning"));
			ctx.ui.setWidget(WIDGET_KEY, ["pi-goals: drafting goals"]);
			return;
		}
		if (state.phase === "starting") {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "starting supervisor"));
			ctx.ui.setWidget(WIDGET_KEY, ["pi-goals: starting the supervisor session"]);
			return;
		}
		const goals = scanGoals(readPlan(ctx));
		if (goals.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const done = goals.filter((g) => g.status === "done").length;
		const auto = state.autoPaused ? " · waiting for user" : state.autoIntervalMs === null ? "" : ` · auto ${state.autoIntervalMs / 60_000}m`;
		const steward = state.stewardEnabled ? " · supervisor" : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◷ ${done}/${goals.length} goals${auto}${steward}`));
		const mark: Record<GoalStatus, string> = { done: "✔", active: "▸", open: "◻", cancelled: "✗" };
		// Only live goals get lines so finished work never pushes current work off screen. The active
		// goal also shows its open subtasks: this file is the task list, so the widget is the task list.
		// No path line: the session id makes it 47 chars, too long to be worth a widget row. The
		// human opens the file from the Ready menu, and every injected reminder still names it.
		const plan = readPlan(ctx);
		const lines: string[] = state.autoPaused ? [ctx.ui.theme.fg("warning", "⏸ waiting for user")] : [];
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
			try { await supervisorRequest(pi, "stop", { bindingId: state.supervisor.id }); }
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
		state = { ...state, phase: "starting" };
		persist(); updateWidget(ctx);
		try {
			if (recoveringWorker) {
				const workerReady = await models.enter("worker", ctx);
				if (signal.aborted || state.planVersion !== version || !state.stewardEnabled) return;
				if (planHash(readPlan(ctx)) !== approvedDraft) throw new Error("The plan changed during model recovery; select Ready again");
				if (!workerReady) { state = { ...state, phase: "planning" }; persist(); updateWidget(ctx); return; }
			}
			const binding = await startSupervisor(pi, ctx, planPath(ctx), state.supervisor, supervisor => {
				if (signal.aborted) return;
				state = { ...state, supervisor }; persist();
			}, signal);
			if (signal.aborted || state.planVersion !== version || !state.stewardEnabled) return;
			if (planHash(readPlan(ctx)) !== approvedDraft) { await supervisorRequest(pi, "stop", { bindingId: binding.id }); state = { ...state, supervisor: null }; throw new Error("The plan changed during initialization; select Ready again"); }
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
			if (planHash(readPlan(ctx)) !== approvedDraft) { await supervisorRequest(pi, "stop", { bindingId: binding.id }); state = { ...state, supervisor: null }; throw new Error("The plan changed during model restoration; select Ready again"); }
			state = { ...state, modelRecovery: null }; persist();
			await supervisorRequest(pi, "activate", { bindingId: binding.id }, signal);
			if (signal.aborted || state.planVersion !== version || state.supervisor?.id !== binding.id || !state.stewardEnabled) return;
			if (planHash(readPlan(ctx)) !== approvedDraft) { await supervisorRequest(pi, "stop", { bindingId: binding.id }); state = { ...state, supervisor: null }; throw new Error("The plan changed during activation; select Ready again"); }
			state = { ...state, phase: "working" };
			persist(); updateWidget(ctx);
			pi.sendUserMessage(handoff, { deliverAs: "followUp" });
		} catch (error) {
			if (signal.aborted) return;
			state = { ...state, phase: "planning", modelRecovery: null }; persist(); updateWidget(ctx);
			ctx.ui.notify(`Could not initialize the supervisor: ${String(error)}. Use /goals supervisor to inspect startup, or /goals steward off and retry Ready.`, "error");
		} finally {
			if (!lifetime.signal.aborted && state.phase !== "working" && !state.modelRecovery) {
				await models.enter("planning", ctx);
				if (!state.phase) models.leave();
			}
			if (operation === controller) operation = null;
		}
	}

	// --- /goals: enter plan mode (or clear / set judge / set steward) -------------------------------

	pi.registerCommand("goals", {
		description: `Plan mode: draft goals into ${PLAN_SHAPE}, review, then work them. /goals plan <objective> | /goals model current | /goals supervisor | /goals worker | /goals zoom | /goals <objective> | /goals clear | /goals auto [minutes|off] | /goals judge <model> | /goals steward [on|off|status]`,
		handler: async (args, ctx) => {
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
						const status = await supervisorRequest<{ connected: boolean }>(pi, "status");
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
			await stopSupervisor(ctx);
			if (!await models.enter("planning", ctx)) return;
			state = {
				...state,
				phase: "planning",
				modelRecovery: null,
				reviewRequested: false,
				questionsWaived: waivesAlignment(arg),
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

	/** What the next saved reminder should carry: a one-shot resync, or a staleness reminder. */
	function dueReminder(ctx: ExtensionContext, plan: string): string | null {
		if (state.phase === "planning" || state.phase === "starting") return null;
		if (!plan.trim()) return null;
		if (resyncReason) return resync(plan, planRel(ctx), resyncReason);
		if (turnsStale < STALE_TURNS) return null;
		const goals = scanGoals(plan);
		if (goals.length === 0) {
			// Non-empty plan but no recognizable goal line: the harness would go silently inert (no
			// widget, no injection, no reminders). Say so instead -- cooperative but confused.
			return `<system-reminder>\n${planRel(ctx)} exists but has no goal line pi-goals recognizes. A goal is a checkbox list line starting "goal:", e.g. "1. [ ] goal: <imperative>" ([ ] open, [/] active, [x] done, [-] cancelled). Reformat it if it's meant to be the plan.\n</system-reminder>`;
		}
		if (!goals.some((g) => g.status === "active" || g.status === "open")) return null;
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

	// Only call at before_agent_start: Pi persists the returned message before model context.
	// If an earlier delivery failed, retain the due state and retry with fresh file text.
	function reminderMessage(ctx: ExtensionContext) {
		confirmReminder(ctx);
		const planning = state.phase === "planning" || state.phase === "starting";
		const content = planning ? planningContextPending ? planningState(planPath(ctx), state.questionsWaived) : null : dueReminder(ctx, readPlan(ctx));
		if (!content) return;
		const id = randomUUID();
		pendingReminder = { id, planning, reason: resyncReason };
		return { customType: planning ? PLANNING_CONTEXT : PLAN_REMINDER, content, display: false, details: { reminderId: id } };
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		const message = reminderMessage(ctx);
		if (message) return { message };
	});

	// PI: Working turns never see an obsolete planning snapshot. Never add ephemeral messages:
	// provider replay must see exactly the reminders saved in the session, including after compact.
	pi.on("context", async (event, ctx) => {
		confirmReminder(ctx);
		if (state.phase === "planning" || state.phase === "starting") return;
		return { messages: event.messages.filter((message) => (message as { customType?: string }).customType !== PLANNING_CONTEXT) };
	});

	// PI: Human plan-mode replies are durable evidence of the interview, not model summaries.
	pi.on("input", async (event, ctx) => {
		if (!models.ready) { ctx.ui.notify("Role model unavailable. Select a different model with /model, explicitly use the current one with /goals model current, or configure the saved model and reload.", "error"); return { action: "handled" as const }; }
		if (event.source !== "extension") {
			clearAutoTimer();
			autoImmediateUsed = false;
			if (state.autoPaused) {
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
		if (state.supervisor && state.phase === "working") void supervisorRequest(pi, "update", { bindingId: state.supervisor.id }).catch((error: Error) => ctx.ui.notify(error.message, "warning"));
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
			const choice = await ctx.ui.select(`Plan drafted in ${planRel(ctx)}.`, ["Ready", "Discuss", "Edit", "Cancel"]);
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
			const version = state.planVersion;
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
		const bootstrap = supervisorBootstrap(ctx);
		if (bootstrap) {
			supervisorOnly = true;
			pi.setActiveTools(pi.getActiveTools().filter(tool => tool !== "CompleteGoal" && tool !== "RequestPlanReview"));
			if (await models.enter("supervisor", ctx)) initializeSupervisor(pi, ctx, bootstrap, lifetime.signal);
			return;
		}
		const last = ctx.sessionManager
			.getEntries()
			.filter((e: { type?: string; customType?: string }) => e.type === "custom" && e.customType === STATE)
			.pop() as { data?: PlanState } | undefined;
		// Upgrade cleared/unused legacy sessions, but never attach supervision mid-plan.
		const saved = last?.data;
		const useNewDefaults = saved?.defaultsVersion !== 1 && saved?.planVersion == null;
		state = {
			defaultsVersion: 1,
			phase: last?.data?.phase === "working" ? "working" : last?.data?.phase ? "planning" : null,
			reviewRequested: last?.data?.reviewRequested ?? true,
			questionsWaived: last?.data?.questionsWaived ?? false,
			modelRecovery: last?.data?.modelRecovery ?? null,
			judgeModel: last?.data?.judgeModel ?? null,
			planVersion: last?.data?.planVersion ?? null,
			autoIntervalMs: useNewDefaults || saved?.autoIntervalMs === undefined ? AUTO_DEFAULT_INTERVAL_MS : saved.autoIntervalMs,
			autoPaused: useNewDefaults ? false : saved?.autoPaused ?? false,
			stewardEnabled: useNewDefaults ? true : saved?.stewardEnabled ?? true,
			supervisor: last?.data?.supervisor ?? null,
		};
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
		operation?.abort();
		clearAutoTimer();
	});

	pi.registerTool({
		name: "RequestPlanReview",
		label: "Review plan",
		description: "Planning only: after task-specific alignment questions have been answered (or explicitly waived for this objective), and the final plan is ready, show the human Ready / Discuss / Edit / Cancel. Do not call while waiting for answers. Call again after discussion is finished, even for an unchanged draft. This does not approve or start work.",
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
			if (state.phase === "planning" || state.phase === "starting") return result("Planning is not approved. Wait for the steward or choose Ready before signing off a goal.", true);
			const plan = readPlan(ctx);
			if (!plan.trim()) return result(`No plan file at ${planRel(ctx)}. Run /goals to draft one.`, true);

			if (supervisorOnly) throw new Error("Only the worker can complete its plan goals");
			if (state.stewardEnabled) {
				if (!state.supervisor) return result("No supervisor is paired. Retry Ready or use /goals steward off.", true);
				const bindingId = state.supervisor.id;
				const hash = planHash(plan);
				try {
					onUpdate?.({ content: [{ type: "text", text: "Supervisor checking trajectory and scope…" }], details: {} });
					const decision = await supervisorRequest<SupervisorDecision>(pi, "review", { bindingId, goal: params.goal, planHash: hash }, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]));
					if (state.supervisor?.id !== bindingId || planHash(readPlan(ctx)) !== hash || decision.bindingId !== bindingId || decision.goal !== params.goal || decision.planHash !== hash) return result("Plan or pairing changed during goal review; retry.", true);
					if (decision.decision !== "approve") return result(`Supervisor: ${decision.decision}. ${decision.reason}`, true);
				} catch (error) { return result(`Supervisor review failed: ${String(error)}`, true); }
			}

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
			if (state.planVersion !== reviewedVersion || state.supervisor?.id !== reviewedPairing || planHash(readPlan(ctx)) !== reviewedPlanHash) return result("The plan or supervisor changed during evidence review; no goal was signed off. Retry.", true);
			if (outcome.logEntry) {
				// Sign-off write: tick the goal [x] (exact-subject match; dogfood showed agent bookkeeping
				// is the drift point) and append the audit log line, one write. On wording drift the tick
				// falls to the agent and the result says so -- both paths are explicit, never silent.
				let updated = readPlan(ctx);
				let tickNote = "";
				if (outcome.logEntry.startsWith("signed off")) {
					const ticked = tickGoal(updated, params.goal);
					updated = ticked ?? updated;
					tickNote = ticked
						? `\n\nGoal ticked [x] in ${planRel(ctx)}.`
						: `\n\nNo exact goal line matched your wording -- tick it [x] in ${planRel(ctx)} yourself.`;
				}
				writePlan(ctx, appendLog(updated, `${stamp()} ${outcome.logEntry}${transcriptNote}`));
				updateWidget(ctx);
				return result(outcome.resultText + tickNote, outcome.isError);
			}
			return result(outcome.resultText, outcome.isError);
		},
	});
	// Registered after role restoration, so rejoin cannot start a supervisor turn on the worker model.
	supervise(pi, () => models.ready);
	function modelRecovered(ctx: ExtensionContext): void {
		if (supervisorOnly) {
			const bootstrap = supervisorBootstrap(ctx);
			if (bootstrap) initializeSupervisor(pi, ctx, bootstrap, lifetime.signal);
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

	if (signal?.aborted) return { resultText: "Sign-off aborted.", isError: true, logEntry: null };

	// Judge ran but failed/errored/timed out: fail forward, say so in the log.
	if (judge.error) {
		const partial = judge.output ? `\n\npartial judge output:\n${judge.output}` : "";
		return {
			resultText: `Judge ran but failed (${judge.error}). Accepted inconclusive — logged.${partial}`,
			isError: false,
			logEntry: `signed off "${input.goal}" (judge inconclusive: ran but failed: ${oneLine(judge.error)})`,
		};
	}

	const verdictLine = judge.output.split("\n").find((l) => /^\s*VERDICT\s*:/i.test(l)) ?? "";
	const verdict = /^\s*VERDICT\s*:\s*(accept|reject)\s*$/i.exec(verdictLine)?.[1]?.toLowerCase();
	const reasoning = judge.output.length > 2000 ? `...\n${judge.output.slice(-2000)}` : judge.output;

	if (verdict === "accept") {
		const beforeVerdict = judge.output.slice(0, judge.output.indexOf(verdictLine));
		const checks = /^#{0,6}\s*(?:\*\*)?checks(?:\*\*)?:\s*$[\s\S]*^[-*]\s+.+$/im.test(beforeVerdict);
		if (!checks) {
			return {
				resultText: `Sign-off REJECTED. Missing:\nchecked-artifact list before VERDICT: accept\n\n--- judge ---\n${reasoning}`,
				isError: true,
				logEntry: `reject "${input.goal}": judge accept had no checked-artifact list`,
			};
		}
		return {
			resultText: `Sign-off ACCEPTED (log line appended).\n\n--- judge ---\n${reasoning}`,
			isError: false,
			logEntry: `signed off "${input.goal}" (judge accept)`,
		};
	}
	if (verdict === "reject") {
		const missing = judge.output.match(/missing\s*:\s*([\s\S]*)$/i)?.[1].trim() || judge.output.slice(-500);
		return {
			resultText: `Sign-off REJECTED. Missing:\n${missing}\n\n--- judge ---\n${reasoning}`,
			isError: true,
			logEntry: `reject "${input.goal}": ${oneLine(missing)}`,
		};
	}
	// No VERDICT line: same fail-forward as a judge error -- the judge ran but didn't answer.
	return {
		resultText: `Judge returned no VERDICT line. Accepted inconclusive — logged.\n\n--- judge ---\n${reasoning || "(no output)"}`,
		isError: false,
		logEntry: `signed off "${input.goal}" (judge inconclusive: no VERDICT line)`,
	};
}

/** Tick the goal line whose subject exactly matches `goal` (trimmed, case-insensitive) to [x].
 *  Null when there is no unique exact match (wording drift / duplicates) -- the caller then asks the
 *  agent to tick it itself. Reuses GOAL_LINE; deliberately NOT fuzzy, that's the judge's job. */
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
