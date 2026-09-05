/**
 * PI: pi-goals owns one versioned plan per session. The main agent is a thin coordinator for a
 * retained pi-subagents supervisor, which owns a nested retained implementation worker and approval.
 *
 * Each /goals call makes `.pi/plan/<session_id>-vN.md`. The selected version survives resume and
 * compaction. Old plans stay on disk but inactive. A session with no selected plan has no widget,
 * supervision, worker, or CompleteGoal sign-off.
 *
 * TypeScript reads only goal checkbox lines for the widget. Models read the plan as prose. The
 * worker edits the project and records evidence. The supervisor inspects it and writes a private
 * approval checkpoint. pi-subagents owns the supervisor and worker sessions, forks, resume, events,
 * and Fleet controls.
 *
 * -- Pi/Codex
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approvalMatches, approvalPath, goalBlock, hashGoalBlock, readApproval, repositoryState } from "./approval.js";
import { completeGoalDescription, completeGoalParamDescription, planDrafting, planningState, resync } from "./prompts.js";
import {
	processWorkState,
	registerGoalSupervisor,
	resumeGoalSupervisor,
	startGoalSupervisor,
	steerGoalSupervisor,
	subagentWorkState,
} from "./worker.js";

const STATE = "pi-goals-state";
const STATUS_KEY = "pi-goals";
const WIDGET_KEY = "pi-goals-widget";
const PLANNING_CONTEXT = "pi-goals-planning-context";
const PLAN_DIR = ".pi/plan";
// For static text (the /goals description) where there is no ctx to resolve the session id.
const PLAN_SHAPE = `${PLAN_DIR}/<session_id>-vN.md`;
// Plan mode blocks edit/write except for its plan file. bash remains available for read-only inspection. -- Pi/Codex
const PLAN_MODE_BLOCKED_TOOLS = ["edit", "write"];
const AUTO_DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;

// A checkbox line beginning "goal:", used by the widget and supervisor scheduling.
// Everything else reads the file as prose.
const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*goal:\s*(.*)$/i;
// An indented checkbox line that isn't a goal: a subtask. Only the widget reads these, so the human
// sees the next action and not just the goal -- this file IS the task list.
const SUBTASK_LINE = /^\s+(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*(.*)$/;
// The fold separates current goals from the longer research record.
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

/** Return the short current-goal section above "## Log". Exported for the unit test. */
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

/** Goal workers run in child Pi sessions, so they must not receive the main coordinator's tool gate. */
export function isSupervisorProcess(isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1"): boolean {
	return !isSubagentChild;
}

interface PlanState {
	phase: Phase;
	workerModel: string | null;
	workerRunId: string | null;
	workerPending: boolean;
	planVersion: number | null;
	autoIntervalMs: number | null;
}

export default function piGoalsExtension(pi: ExtensionAPI): void {
	if (!isSupervisorProcess()) return;
	let state: PlanState = {
		phase: null,
		workerModel: null,
		workerRunId: null,
		workerPending: false,
		planVersion: null,
		autoIntervalMs: null,
	};
	let planningContextPending = false;
	let autoTimer: ReturnType<typeof setTimeout> | null = null;
	let supervisorWakePending = false;
	let workerRegistration: { dispose(): void } | null = null;
	let workerRegistrationError: string | null = null;
	let unsubscribeWorkerCompletion: (() => void) | null = null;
	let workerLaunchPending = false;
	const workerCompletionsDuringLaunch = new Set<string>();
	// Set on session start and after compaction; the next supervisor call receives the whole plan.
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

	function setupWorker(ctx: ExtensionContext): void {
		workerRegistration?.dispose();
		workerRegistration = null;
		workerRegistrationError = null;
		try {
			workerRegistration = registerGoalSupervisor(pi.events, state.workerModel);
		} catch (error) {
			workerRegistrationError = error instanceof Error ? error.message : String(error);
			if (state.phase === "working") ctx.ui.notify(`Goal supervisor unavailable: ${workerRegistrationError}`, "warning");
		}
	}

	function rememberWorkerRun(runId: string): void {
		state = { ...state, workerRunId: runId, workerPending: !workerCompletionsDuringLaunch.delete(runId) };
		persist();
	}

	async function startOrResumeWorker(ctx: ExtensionContext, task: string, signal?: AbortSignal): Promise<string> {
		if (workerLaunchPending) throw new Error("A goal-worker launch is already in progress.");
		if (!workerRegistration) setupWorker(ctx);
		if (!workerRegistration) throw new Error(`Goal worker unavailable: ${workerRegistrationError ?? "pi-subagents is not ready"}.`);
		workerLaunchPending = true;
		workerCompletionsDuringLaunch.clear();
		try {
			const runId = state.workerRunId
				? await resumeGoalSupervisor(pi.events, state.workerRunId, task, signal)
				: await startGoalSupervisor(pi.events, ctx.cwd, task, signal);
			rememberWorkerRun(runId);
			return runId;
		} finally {
			workerLaunchPending = false;
			workerCompletionsDuringLaunch.clear();
		}
	}

	function watchWorkerCompletion(): void {
		unsubscribeWorkerCompletion?.();
		unsubscribeWorkerCompletion = pi.events.on("subagent:async-complete", (raw) => {
			if (!raw || typeof raw !== "object") return;
			const runId = (raw as { runId?: string }).runId;
			if (!runId) return;
			if (runId !== state.workerRunId) {
				if (workerLaunchPending) workerCompletionsDuringLaunch.add(runId);
				return;
			}
			state = { ...state, workerPending: false };
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

	function supervisorTask(ctx: ExtensionContext, instruction: string): string {
		const plan = readPlan(ctx);
		const checkpoints = scanGoals(plan)
			.filter((goal) => goal.status === "active" || goal.status === "open")
			.map((goal) => `- ${JSON.stringify(goal.subject)}: ${approvalPath(ctx.cwd, ctx.sessionManager.getSessionId(), goal.subject)}`)
			.join("\n");
		return `${instruction}\n\nYou are the retained goal-supervisor. Here is the complete current plan; inspect its exact goal blocks and cited evidence before directing or approving work.\nPlan path: ${planPath(ctx)}\nPrivate approval checkpoints, one per current goal:\n${checkpoints || "(no open goals)"}\n\n${plan}`;
	}

	function wakeSupervisor(ctx: ExtensionContext, reason: string): void {
		if (supervisorWakePending || state.phase !== "working" || !activeGoals(ctx)) return;
		supervisorWakePending = true;
		void (async () => {
			try {
				const task = supervisorTask(ctx, `${reason}\nReview the current goal and either continue, redirect, or approve it through ApproveGoal.`);
				if (state.workerPending && state.workerRunId) await steerGoalSupervisor(pi.events, state.workerRunId, task);
				else await startOrResumeWorker(ctx, task);
			} catch (error) {
				ctx.ui.notify(`Goal supervisor check failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} finally {
				supervisorWakePending = false;
			}
		})();
	}

	function scheduleSupervisorCheck(ctx: ExtensionContext): void {
		if (autoTimer !== null || state.phase !== "working" || state.autoIntervalMs === null || !activeGoals(ctx)) return;
		autoTimer = setTimeout(() => {
			autoTimer = null;
			scheduleSupervisorCheck(ctx);
			wakeSupervisor(ctx, `The ${state.autoIntervalMs! / 60_000}-minute supervisor check is due.`);
		}, state.autoIntervalMs);
		autoTimer.unref();
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
		const liveGoals = goals.filter((g) => g.status === "active" || g.status === "open");
		const stateLabel = liveGoals.length > 0 ? " · supervising…" : " · complete";
		const auto = liveGoals.length > 0 && state.autoIntervalMs !== null ? ` · supervise ${state.autoIntervalMs / 60_000}m` : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◷ ${done}/${goals.length} goals${stateLabel}${auto}`));
		const mark: Record<GoalStatus, string> = { done: "✔", active: "▸", open: "◻", cancelled: "✗" };
		// Only live goals get lines so finished work never pushes current work off screen. The active
		// goal also shows its open subtasks: this file is the task list, so the widget is the task list.
		// No path line: the session id makes it too long to be useful in the widget.
		const plan = readPlan(ctx);
		const lines: string[] = liveGoals.length === 0 ? ["✔ complete"] : [];
		for (const g of liveGoals) {
			lines.push(`${mark[g.status]} ${g.status === "active" ? "supervising… " : ""}${g.subject}`);
			if (g.status === "active") lines.push(...openSubtasks(plan, g.line).slice(0, 3).map((s) => ctx.ui.theme.fg("muted", `   ◦ ${s}`)));
		}
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	// --- /goals: enter plan mode or configure supervision -- Pi/Codex -----------------------------

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
				state = { ...state, phase: null, workerRunId: null, workerPending: false, planVersion: null, autoIntervalMs: null };
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`Disconnected from ${currentPlan}; the file remains on disk.`, "info");
				return;
			}
			if (arg === "auto" || arg.startsWith("auto ")) {
				const value = arg.slice("auto".length).trim();
				if (value === "off") {
					clearAutoTimer();
					state = { ...state, autoIntervalMs: null };
					persist();
					updateWidget(ctx);
					ctx.ui.notify("Hourly goal supervision disabled.", "info");
					return;
				}
				if (state.phase !== "working") {
					ctx.ui.notify("Approve a plan with Ready before enabling supervision.", "warning");
					return;
				}
				const minutes = value ? Number(value) : AUTO_DEFAULT_INTERVAL_MS / 60_000;
				if (!Number.isInteger(minutes) || minutes < 1) {
					ctx.ui.notify("Use /goals auto [whole minutes], or /goals auto off.", "warning");
					return;
				}
				clearAutoTimer();
				state = { ...state, autoIntervalMs: minutes * 60_000 };
				persist();
				updateWidget(ctx);
				scheduleSupervisorCheck(ctx);
				ctx.ui.notify(`Goal supervision will check every ${minutes}m.`, "info");
				return;
			}
			if (arg === "model" || arg.startsWith("model ")) {
				const ref = arg.slice("model".length).trim();
				state = { ...state, workerModel: ref || null, workerRunId: null, workerPending: false };
				persist();
				setupWorker(ctx);
				ctx.ui.notify(ref ? `Goal-supervisor model set to ${ref}` : "Goal-supervisor model reset to pi-subagents default", "info");
				return;
			}
			state = { ...state, phase: "planning", workerRunId: null, workerPending: false, planVersion: nextVersion(ctx), autoIntervalMs: null };
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
		if (state.phase === "planning" || !plan.trim() || !resyncReason) return null;
		const why = resyncReason;
		resyncReason = null;
		return resync(plan, planRel(ctx), why);
	}

	// The phase snapshot enters context only when planning starts or context was lost.
	pi.on("before_agent_start", async (_event, ctx) => {
		supervisorWakePending = false;
		if (state.phase === "working") {
			return {
				systemPrompt: `${ctx.getSystemPrompt()}\n\nYou are the thin human-facing coordinator for ${planRel(ctx)}. The retained goal-supervisor owns nested-worker control and acceptance. Keep the human intent stable, inspect progress with read-only tools, and direct the supervisor through GuideGoalWorker. Built-in edit/write and write-like shell commands are blocked. CompleteGoal is a mechanical sign-off only: it fails closed unless the supervisor's private approval checkpoint still matches the exact goal, plan block, committed HEAD/tree, and clean worktree. This is not a filesystem sandbox: allowed verification scripts and other custom tools can still mutate. Do not approve implementation by prose alone. -- Pi/Codex`,
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
		if (state.phase === "planning" && planningContextPending) {
			planningContextPending = false;
			return { messages: [...messages, { role: "user" as const, content: [{ type: "text" as const, text: planningState(planPath(ctx)) }], timestamp: Date.now() }] };
		}
		const text = dueInjection(ctx, readPlan(ctx));
		if (!text) return removedPlanningContext ? { messages } : undefined;
		return { messages: [...messages, { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() }] };
	});

	// PI: Human plan-mode replies are durable evidence of the interview, not model summaries.
	pi.on("input", async (event, ctx) => {
		if (state.phase === "planning" && event.source !== "extension") writePlan(ctx, appendInterview(readPlan(ctx), event.text));
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateWidget(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
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
		if (state.phase === "working") {
			if (PLAN_MODE_BLOCKED_TOOLS.includes(event.toolName)) {
				return { block: true, reason: "Working supervision is read-only: direct implementation and evidence writes to GuideGoalWorker. CompleteGoal is the explicit sign-off control." };
			}
			if (event.toolName === "bash" && !isSupervisorReadOnlyCommand(String((event.input as { command?: string }).command))) {
				return { block: true, reason: "Working supervision allows inspection and standard verification commands only. Direct file changes belong to GuideGoalWorker; this is not a full sandbox for custom tools or allowed scripts." };
			}
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
			scheduleSupervisorCheck(ctx);
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
			const choice = await ctx.ui.select(`Plan drafted in ${planRel(ctx)}.`, ["Ready", "Ready (compact)", "Refine", "Edit", "Cancel"]);
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
				state = { ...state, phase: null, workerRunId: null, workerPending: false, planVersion: null, autoIntervalMs: null };
				persist();
				updateWidget(ctx);
				ctx.ui.notify("Plan discarded.", "info");
				return;
			}
			if (choice !== "Ready" && choice !== "Ready (compact)") return;
			const startWorking = async (): Promise<boolean> => {
				state = { ...state, phase: "working", autoIntervalMs: AUTO_DEFAULT_INTERVAL_MS };
				resyncReason = "The plan was approved.";
				persist();
				updateWidget(ctx);
				try {
					await startOrResumeWorker(ctx, supervisorTask(ctx, "Start by launching or resuming the nested goal-worker. Then supervise the current plan."));
					scheduleSupervisorCheck(ctx);
					return true;
				} catch (error) {
					ctx.ui.notify(`Goal supervisor could not start: ${error instanceof Error ? error.message : String(error)}`, "warning");
					state = { ...state, phase: "planning", autoIntervalMs: null };
					persist();
					updateWidget(ctx);
					return false;
				}
			};
			const started = await startWorking();
			if (!started || choice === "Ready") return;
			ctx.compact({
				onComplete: () => {
					resyncReason = "The main coordinator was compacted after the retained supervisor started.";
					ctx.ui.notify("Main-session compaction completed; the retained supervisor and worker kept their contexts.", "info");
				},
				onError: (error) => {
					ctx.ui.notify(`Main-session compaction failed; the retained supervisor continues: ${error.message}`, "warning");
				},
			});
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
			workerModel: last?.data?.workerModel ?? null,
			workerRunId: last?.data?.workerRunId ?? null,
			workerPending: last?.data?.workerPending ?? false,
			planVersion: last?.data?.planVersion ?? null,
			autoIntervalMs: last?.data?.autoIntervalMs ?? null,
		};
		watchWorkerCompletion();
		setupWorker(ctx);
		planningContextPending = state.phase === "planning";
		resyncReason = state.phase === "working" ? "New session." : null;
		updateWidget(ctx);
		scheduleSupervisorCheck(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearAutoTimer();
		workerRegistration?.dispose();
		workerRegistration = null;
		unsubscribeWorkerCompletion?.();
		unsubscribeWorkerCompletion = null;
	});

	pi.registerTool({
		name: "CheckGoalWork",
		label: "Check goal work",
		description: "Check whether pi-subagents or pi-processes still has active work before deciding that the goal worker stopped.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			try {
				const [subagents, processes] = await Promise.all([subagentWorkState(pi.events), Promise.resolve(processWorkState(pi.events))]);
				const unknown = subagents === "unknown" || processes === "unknown";
				return result(`subagents=${subagents}; processes=${processes}`, unknown);
			} catch (error) {
				return result(`Goal work status failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	});

	pi.registerTool({
		name: "GuideGoalWorker",
		label: "Guide goal supervisor",
		description: "Send one concrete instruction to the retained goal-supervisor. A live supervisor is steered; a completed supervisor is resumed with its saved context and the full current plan.",
		parameters: Type.Object({
			instruction: Type.String({ description: "The next research or implementation action, with the evidence that should distinguish success from failure." }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (state.phase !== "working") return result("Approve a plan with Ready before directing the goal supervisor.", true);
			const task = supervisorTask(ctx, params.instruction);
			try {
				if (state.workerPending) {
					if (!state.workerRunId) throw new Error("Goal-supervisor state says running but has no run ID.");
					await steerGoalSupervisor(pi.events, state.workerRunId, task, signal);
					return result(`Instruction delivered to live goal supervisor ${state.workerRunId}.`);
				}
				const runId = await startOrResumeWorker(ctx, task, signal);
				return result(`Goal supervisor resumed as ${runId}.`);
			} catch (error) {
				return result(`Goal-supervisor guidance failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	});

	pi.registerTool({
		name: "CompleteGoal",
		label: "Goal signoff",
		description: completeGoalDescription,
		parameters: Type.Object({
			goal: Type.String({ description: completeGoalParamDescription }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (state.phase !== "working") return result("Planning is not approved. Choose Ready before signing off a goal.", true);
			const workState = await subagentWorkState(pi.events);
			if (workState !== "idle") return result(`Goal sign-off blocked while supervisor work is ${workState}.`, true);
			const plan = readPlan(ctx);
			if (!plan.trim()) return result(`No plan file at ${planRel(ctx)}. Run /goals to draft one.`, true);
			const block = goalBlock(plan, params.goal);
			if (!block) return result(`No unique open goal line matched "${params.goal}" in ${planRel(ctx)}.`, true);
			let repository: ReturnType<typeof repositoryState>;
			try {
				repository = repositoryState(ctx.cwd);
			} catch (error) {
				return result(`Goal sign-off could not inspect the repository: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			if (!repository.cleanWorktree) return result("Goal sign-off blocked: worktree is dirty.", true);
			const approval = readApproval(approvalPath(ctx.cwd, ctx.sessionManager.getSessionId(), params.goal));
			if (!approvalMatches(approval, {
				goal: params.goal,
				planPath: planPath(ctx),
				goalBlockHash: hashGoalBlock(block),
				repoRoot: repository.repoRoot,
				head: repository.head,
				tree: repository.tree,
				cleanWorktree: repository.cleanWorktree,
			})) return result("Goal sign-off blocked: no matching supervisor approval checkpoint. Request a fresh supervisor review.", true);
			const ticked = tickGoal(plan, params.goal);
			if (!ticked) return result(`No unique exact goal line matched "${params.goal}" in ${planRel(ctx)}.`, true);
			writePlan(ctx, appendLog(ticked, `${stamp()} mechanically signed off "${params.goal}" after matching supervisor approval`));
			updateWidget(ctx);
			return result(`Sign-off accepted. Goal ticked [x] in ${planRel(ctx)}.`);
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

/** The supervisor may inspect and use ordinary project checks. It is not a shell sandbox: package
 * scripts and custom tools retain their normal process permissions, so implementation still belongs
 * to the worker by contract as well as this direct-tool gate. */
export function isSupervisorReadOnlyCommand(command: string): boolean {
	if (/[|><`$]/.test(command)) return false;
	const safeArgs = "(?:\\s+[A-Za-z0-9_./:=,'\"@+%-]+)*";
	const inspection = new RegExp(`^(?:cd|pwd|ls|rg|grep|find|head|tail|wc|stat|test)${safeArgs}$`);
	const git = new RegExp(`^git\\s+(?:status|log|diff|show|branch|ls-files|grep|check-ignore)${safeArgs}$`);
	const verification = new RegExp(`^(?:npm\\s+test|npm\\s+run\\s+(?:test|typecheck|lint)|npx\\s+tsc\\s+--noEmit)${safeArgs}$`);
	return command.split(/&&|;/).every((part) => inspection.test(part.trim()) || git.test(part.trim()) || verification.test(part.trim()));
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
