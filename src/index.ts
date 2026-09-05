/**
 * PI: pi-goals owns one versioned plan per session. A persistent, read-only pi-subagents child
 * keeps the high-level context, reviews progress, and decides CompleteGoal sign-off.
 *
 * Each /goals call makes `.pi/plan/<session_id>-vN.md`. The selected version survives resume and
 * compaction. Old plans stay on disk but inactive. A session with no selected plan has no widget,
 * injections, steward reviews, or CompleteGoal sign-off.
 *
 * TypeScript reads only goal checkbox lines for the widget. Models read the plan as prose. The
 * worker alone edits it. The steward receives the plan path on every review, rereads the complete
 * file, and can inspect cited artifacts with read-only tools. pi-subagents owns child sessions,
 * persistence, resume, completion events, structured output, and contact with the parent.
 *
 * — Pi/Codex
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { completeGoalDescription, completeGoalParamDescription, planDrafting, planningState, reminder, resync } from "./prompts.js";
import {
	checkpointReview,
	readyReview,
	registerStewardAgent,
	resumeSteward,
	runStewardReview,
	type StewardDecision,
	signoffReview,
	startSteward,
} from "./steward.js";

const STATE = "pi-goals-state";
const STATUS_KEY = "pi-goals";
const WIDGET_KEY = "pi-goals-widget";
const PLANNING_CONTEXT = "pi-goals-planning-context";
const PLAN_DIR = ".pi/plan";
// For static text (the /goals description) where there is no ctx to resolve the session id.
const PLAN_SHAPE = `${PLAN_DIR}/<session_id>-vN.md`;
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

type Phase = "planning" | "working" | null;

interface PlanState {
	phase: Phase;
	stewardModel: string | null;
	stewardRunId: string | null;
	stewardPending: boolean;
	planVersion: number | null;
	autoIntervalMs: number | null;
	autoPaused: boolean;
}

export default function piGoalsExtension(pi: ExtensionAPI): void {
	let state: PlanState = {
		phase: null,
		stewardModel: null,
		stewardRunId: null,
		stewardPending: false,
		planVersion: null,
		autoIntervalMs: null,
		autoPaused: false,
	};
	let planningContextPending = false;
	// The reminder sees only the working set. A repeated Log line must not look like progress.
	let turnsStale = 0;
	let lastSeenWorkingSet = "";
	let autoTimer: ReturnType<typeof setTimeout> | null = null;
	let autoWakeInFlight = false;
	let autoWakesWithoutProgress = 0;
	let autoLastWorkingSet = "";
	let autoImmediateUsed = false;
	let runStartedBackgroundWork = false;
	let stewardRegistration: { dispose(): void } | null = null;
	let stewardRegistrationError: string | null = null;
	let unsubscribeStewardCompletion: (() => void) | null = null;
	// Set on session start and after a compaction; drained by the next LLM call, which then carries
	// the WHOLE file (appendix included) instead of just the working set.
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

	function setupSteward(ctx: ExtensionContext): void {
		stewardRegistration?.dispose();
		stewardRegistration = null;
		stewardRegistrationError = null;
		try {
			stewardRegistration = registerStewardAgent(pi.events, state.stewardModel);
		} catch (error) {
			stewardRegistrationError = error instanceof Error ? error.message : String(error);
			if (state.phase === "working") ctx.ui.notify(`Goal steward unavailable: ${stewardRegistrationError}`, "warning");
		}
	}

	function rememberStewardRun(runId: string): void {
		state = { ...state, stewardRunId: runId, stewardPending: true };
		persist();
	}

	async function reviewInBackground(ctx: ExtensionContext, task: string): Promise<void> {
		if (!stewardRegistration) {
			ctx.ui.notify(`Goal steward unavailable: ${stewardRegistrationError ?? "pi-subagents is not ready"}. Install pi-subagents and reload Pi.`, "warning");
			return;
		}
		if (state.stewardPending) return;
		try {
			const runId = state.stewardRunId
				? await resumeSteward(pi.events, state.stewardRunId, task)
				: await startSteward(pi.events, ctx.cwd, task);
			rememberStewardRun(runId);
		} catch (error) {
			ctx.ui.notify(`Goal steward could not start: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	function watchStewardCompletion(): void {
		unsubscribeStewardCompletion?.();
		unsubscribeStewardCompletion = pi.events.on("subagent:async-complete", (raw) => {
			if (!raw || typeof raw !== "object" || (raw as { runId?: string }).runId !== state.stewardRunId) return;
			state = { ...state, stewardPending: false };
			persist();
		});
	}

	function clearAutoTimer(): void {
		if (autoTimer !== null) clearTimeout(autoTimer);
		autoTimer = null;
	}

	function activeGoals(ctx: ExtensionContext): boolean {
		return scanGoals(readPlan(ctx)).some((goal) => goal.status === "active" || goal.status === "open");
	}

	function scheduleAutoContinue(ctx: ExtensionContext, delayMs = state.autoIntervalMs): void {
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
		if (state.phase === "planning") {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "planning"));
			ctx.ui.setWidget(WIDGET_KEY, ["pi-goals: drafting goals"]);
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
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◷ ${done}/${goals.length} goals${auto}`));
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

	// --- /goals: enter plan mode (or clear / configure the steward) — Pi/Codex ---------------------

	pi.registerCommand("goals", {
		description: `Plan mode: draft goals into ${PLAN_SHAPE}, review, then work them. /goals <objective> | /goals clear | /goals auto [minutes|off] | /goals model <model>`,
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "clear") {
				if (state.planVersion === null) {
					ctx.ui.notify("No active plan to disconnect.", "info");
					return;
				}
				const currentPlan = planRel(ctx);
				clearAutoTimer();
				state = { ...state, phase: null, stewardRunId: null, stewardPending: false, planVersion: null, autoIntervalMs: null, autoPaused: false };
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`Disconnected from ${currentPlan}; the file remains on disk.`, "info");
				return;
			}
			if (arg === "auto" || arg.startsWith("auto ")) {
				const value = arg.slice("auto".length).trim();
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
			if (arg === "model" || arg.startsWith("model ")) {
				const ref = arg.slice("model".length).trim();
				state = { ...state, stewardModel: ref || null, stewardRunId: null, stewardPending: false };
				persist();
				setupSteward(ctx);
				ctx.ui.notify(ref ? `Goal-steward model set to ${ref}` : "Goal-steward model reset to pi-subagents default", "info");
				return;
			}
			state = { ...state, phase: "planning", stewardRunId: null, stewardPending: false, planVersion: nextVersion(ctx) };
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

	/** What this LLM call should carry, if anything: a one-shot resync, or a staleness reminder. */
	function dueInjection(ctx: ExtensionContext, plan: string): string | null {
		const drainResync = (): string | null => {
			const why = resyncReason;
			resyncReason = null;
			return why;
		};
		if (state.phase === "planning") return null;
		if (!plan.trim()) return null;
		const why = drainResync();
		if (why) return resync(plan, planRel(ctx), why);
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

	// The phase snapshot enters context only when planning starts or context was lost.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (state.phase !== "planning" || !planningContextPending) return;
		planningContextPending = false;
		return { message: { customType: PLANNING_CONTEXT, content: planningState(planPath(ctx)), display: false } };
	});

	// PI: Working turns never see an obsolete planning snapshot. Auto-compaction retries skip
	// before_agent_start, so context restores the planning snapshot exactly once in that path.
	pi.on("context", async (event, ctx) => {
		const messages = state.phase === "planning" ? event.messages : event.messages.filter((message) => (message as { customType?: string }).customType !== PLANNING_CONTEXT);
		if (state.phase === "planning" && planningContextPending) {
			planningContextPending = false;
			return { messages: [...messages, { role: "user" as const, content: [{ type: "text" as const, text: planningState(planPath(ctx)) }], timestamp: Date.now() }] };
		}
		const text = dueInjection(ctx, readPlan(ctx));
		if (!text) return messages === event.messages ? undefined : { messages };
		turnsStale = 0;
		return { messages: [...messages, { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() }] };
	});

	// PI: Human plan-mode replies are durable evidence of the interview, not model summaries.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") {
			clearAutoTimer();
			autoImmediateUsed = false;
			if (state.autoPaused) {
				state = { ...state, autoPaused: false };
				persist();
				updateWidget(ctx);
			}
		}
		if (state.phase === "planning" && event.source !== "extension") writePlan(ctx, appendInterview(readPlan(ctx), event.text));
	});

	// The staleness clock sees only the working set. Log updates are durable evidence, not progress.
	pi.on("turn_end", async (_event, ctx) => {
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
		if (state.phase !== "planning") return;
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
	pi.on("session_compact", async () => {
		if (state.phase === "planning") planningContextPending = true;
		else resyncReason = "The session was just compacted.";
	});

	// PI: Print after Pi settles. agent_end is still streaming, so its message queues behind the menu.
	pi.on("agent_settled", async (_event, ctx) => {
		if (state.phase === "working") {
			if (turnsStale >= STALE_TURNS && activeGoals(ctx)) await reviewInBackground(ctx, checkpointReview(planRel(ctx), turnsStale));
			settleAuto(ctx);
			return;
		}
		if (state.phase !== "planning" || !ctx.hasUI) return;
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
			const choice = await ctx.ui.select(`Plan drafted in ${planRel(ctx)}.`, ["Ready", "Refine", "Edit", "Cancel"]);
			if (choice === "Refine") {
				const notes = await ctx.ui.editor("What should change about the plan?", "");
				if (!notes?.trim()) continue;
				writePlan(ctx, appendInterview(plan, notes));
				planningContextPending = true;
				pi.sendUserMessage(`Revise the plan at ${planPath(ctx)} using these human notes:\n\n${notes}\n\nKeep the same goal structure.`, { deliverAs: "followUp" });
				return;
			}
			if (choice === "Edit") {
				const edited = await ctx.ui.editor("Edit the plan", plan);
				if (edited !== undefined && edited !== plan) writePlan(ctx, edited);
				continue;
			}
			if (choice === "Cancel") {
				rmSync(planPath(ctx), { force: true });
				state = { ...state, phase: null, stewardRunId: null, stewardPending: false, planVersion: null };
				persist();
				updateWidget(ctx);
				ctx.ui.notify("Plan discarded.", "info");
				return;
			}
			if (choice !== "Ready") return;
			state = { ...state, phase: "working" };
			persist();
			updateWidget(ctx);
			await reviewInBackground(ctx, readyReview(planRel(ctx)));
			pi.sendUserMessage(`Work the goals in ${planPath(ctx)}. Pick an open goal, mark it active ([/]), work its subtasks, and when its discriminator is satisfied fill its evidence: list, then call CompleteGoal with the goal's text. Keep the plan file current as you go.`, { deliverAs: "followUp" });
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
			stewardModel: last?.data?.stewardModel ?? null,
			stewardRunId: last?.data?.stewardRunId ?? null,
			stewardPending: last?.data?.stewardPending ?? false,
			planVersion: last?.data?.planVersion ?? null,
			autoIntervalMs: last?.data?.autoIntervalMs ?? null,
			autoPaused: last?.data?.autoPaused ?? false,
		};
		watchStewardCompletion();
		setupSteward(ctx);
		lastSeenWorkingSet = foldPlan(readPlan(ctx));
		autoLastWorkingSet = lastSeenWorkingSet;
		planningContextPending = state.phase === "planning";
		resyncReason = state.phase === "working" ? "New session." : null;
		updateWidget(ctx);
		scheduleAutoContinue(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearAutoTimer();
		stewardRegistration?.dispose();
		stewardRegistration = null;
		unsubscribeStewardCompletion?.();
		unsubscribeStewardCompletion = null;
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
			if (state.phase === "planning") return result("Planning is not approved. Choose Ready before signing off a goal.", true);
			const plan = readPlan(ctx);
			if (!plan.trim()) return result(`No plan file at ${planRel(ctx)}. Run /goals to draft one.`, true);

			if (!stewardRegistration) {
				return result(`Goal steward unavailable: ${stewardRegistrationError ?? "pi-subagents is not ready"}. Install pi-subagents and reload Pi.`, true);
			}
			if (state.stewardPending) return result("The goal steward is still reviewing the previous checkpoint. Retry CompleteGoal after its result arrives.", true);
			onUpdate?.({ content: [{ type: "text", text: `Persistent goal steward inspecting: ${params.goal}` }], details: {} });
			let reviewRunId = "";
			let decision: StewardDecision;
			try {
				const review = await runStewardReview(
					pi.events,
					ctx.cwd,
					state.stewardRunId,
					signoffReview(planRel(ctx), params.goal),
					signal,
					600_000,
					rememberStewardRun,
				);
				reviewRunId = review.runId;
				decision = review.decision;
			} catch (error) {
				return result(`Goal-steward review failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			state = { ...state, stewardPending: false };
			persist();
			const outcome = decideStewardSignOff(params.goal, decision, reviewRunId);
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
				writePlan(ctx, appendLog(updated, `${stamp()} ${outcome.logEntry}`));
				updateWidget(ctx);
				return result(outcome.resultText + tickNote, outcome.isError);
			}
			return result(outcome.resultText, outcome.isError);
		},
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

export interface SignOffOutcome {
	resultText: string;
	isError: boolean;
	logEntry: string;
}

export function decideStewardSignOff(goal: string, decision: StewardDecision, runId: string): SignOffOutcome {
	if (decision.verdict === "accept") {
		return {
			resultText: `Sign-off ACCEPTED.\n\nGoal steward: ${decision.summary}\nRun: ${runId}`,
			isError: false,
			logEntry: `signed off "${goal}" (steward accept; run ${runId})`,
		};
	}
	const missing = decision.verdict === "reject"
		? decision.missingEvidence?.join("; ") || decision.summary
		: decision.verdict === "redirect"
			? decision.nextAction ?? decision.summary
			: `The steward returned let_run instead of a sign-off verdict: ${decision.summary}`;
	return {
		resultText: `Sign-off REJECTED. Missing:\n${missing}\n\nGoal steward: ${decision.summary}\nRun: ${runId}`,
		isError: true,
		logEntry: `reject "${goal}": ${oneLine(missing)} (steward run ${runId})`,
	};
}

/** Tick the goal line whose subject exactly matches `goal` (trimmed, case-insensitive) to [x].
 *  Null when there is no unique exact match (wording drift / duplicates) -- the caller then asks the
 *  agent to tick it itself. Reuses GOAL_LINE; deliberately not fuzzy; the steward reads prose. */
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
