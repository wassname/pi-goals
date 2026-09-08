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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approvalMatches, approvalPath, goalBlock, hashGoalBlock, readApproval, repositoryState } from "./approval.js";
import { backgroundState } from "./background.js";
import { closeSupervisorPane, openSupervisorPane } from "./herdr.js";
import { GoalIntercom } from "./intercom.js";
import { FOLD_LINE, foldPlan, GOAL_LINE } from "./plan.js";
import { completeGoalDescription, completeGoalParamDescription, planDrafting, planningState, resync } from "./prompts.js";
import { RoleModels } from "./role-models.js";
import { isVisibleSupervisor, registerVisibleSupervisor } from "./supervisor-session.js";
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

export function isMainSession(isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1"): boolean {
	return !isSubagentChild && !isVisibleSupervisor();
}

interface PlanState {
	phase: Phase;
	supervisorModel: string | null;
	supervisorPaneId: string | null;
	approvalId: string | null;
	planVersion: number | null;
	latestDirection: string;
}

export default function piGoalsExtension(pi: ExtensionAPI): void {
	if (isVisibleSupervisor()) {
		registerVisibleSupervisor(pi);
		return;
	}
	if (!isMainSession()) return;
	const intercom = new GoalIntercom(pi);
	const models = new RoleModels(pi);
	intercom.onSteer = (instruction) => {
		if (state.phase !== "working" || modelError) throw new Error("Worker is paused or its plan is not active; instruction not delivered. Use /goals reconnect after selecting an available model.");
		pi.sendUserMessage(`[supervisor] ${instruction}`, { deliverAs: "steer" });
	};
	let state: PlanState = {
		phase: null,
		supervisorModel: null,
		supervisorPaneId: null,
		approvalId: null,
		planVersion: null,
		latestDirection: "",
	};
	let modelError: string | null = null;
	let readyAttempt: object | undefined;
	intercom.onConnectionChange = (ctx) => updateWidget(ctx);
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

	function pauseReason(): string | null {
		if (!state.phase) return null;
		if (modelError) return `${modelError} Select /model, then run /goals reconnect.`;
		if (state.phase === "working" && !intercom.connected) return intercom.peerPresent
			? "Supervisor is present but not ready. Inspect its pane for startup/compaction or model errors; recover with /model then /goals reconnect in the supervisor pane if needed."
			: "Supervisor disconnected. Run /goals reconnect, or /goals restart to replace its tracked pane without discarding the plan.";
		return null;
	}

	async function restoreModel(role: "planning" | "worker", ctx: ExtensionContext): Promise<void> {
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

	async function startSupervisor(ctx: ExtensionContext, isCurrent = () => !intercom.ended): Promise<void> {
		if (intercom.ended) throw new Error("Session ended before supervisor startup.");
		repositoryRoot(ctx.cwd);
		const sourceSessionFile = ctx.sessionManager.getSessionFile();
		if (!sourceSessionFile) throw new Error("The current session is not persisted, so it cannot be forked.");
		if (state.supervisorPaneId && state.approvalId) {
			intercom.configure(state.approvalId, "worker", ctx, false);
			await intercom.waitReady(5000, { peerOnly: true });
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
			if (paneId) throw new Error(`Supervisor startup failed in Herdr pane ${paneId}; it remains open for inspection. ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
		if (!current()) throw new Error("Supervisor startup was cancelled.");
		state = { ...state, supervisorPaneId: paneId };
		persist();
		await intercom.waitReady(undefined, { peerOnly: true });
	}

	let workerTurns = 0;
	let viewGeneration = 0;
	let viewTimer: ReturnType<typeof setInterval> | undefined;

	async function publishWorkerView(ctx: ExtensionContext, reason: "ready" | "settled" | "turns" | "interval" | "started"): Promise<void> {
		if (state.phase !== "working" || modelError || !intercom.bound) return;
		const generation = ++viewGeneration;
		const binding = state.approvalId;
		const background = reason === "started" ? { quiet: false, description: "agent starting; background state not queried" } : await backgroundState(pi);
		if (!intercom.bound || modelError || generation !== viewGeneration || binding !== state.approvalId || state.phase !== "working") return;
		const entries = ctx.sessionManager.getBranch();
		const view = workerView(entries, reason, reason !== "started" && ctx.isIdle(), {
			sourceSession: ctx.sessionManager.getSessionFile()!, latestDirection: state.latestDirection,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected",
			since: intercom.acknowledgedEntry, background: background.description,
		});
		intercom.view(view, reason, entries.at(-1)?.id, background.quiet);
		const goals = scanGoals(readPlan(ctx));
		if (goals.length > 0 && goals.every((goal) => goal.status === "done" || goal.status === "cancelled")) {
			stopWorkerTimers();
			state = { ...state, phase: null };
			models.leave();
			persist();
			intercom.detach();
		}
	}

	function startWorkerTimers(ctx: ExtensionContext): void {
		if (!viewTimer) viewTimer = setInterval(() => {
			void publishWorkerView(ctx, "interval").catch(error => { if (!intercom.ended) ctx.ui.notify(`Worker view failed: ${String(error)}`, "error"); });
		}, 60 * 60_000);
	}

	function stopWorkerTimers(): void {
		if (viewTimer) clearInterval(viewTimer);
		viewTimer = undefined;
	}

	async function stopSupervisor(): Promise<boolean> {
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
		const paused = pauseReason();
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
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const done = goals.filter((g) => g.status === "done").length;
		const liveGoals = goals.filter((g) => g.status === "active" || g.status === "open");
		const stateLabel = liveGoals.length > 0 ? " · supervised" : " · complete";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◷ ${done}/${goals.length} goals${stateLabel}`));
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
		description: `Plan goals, then open a visible supervisor session. /goals <objective> | reconnect | restart | clear | model <supervisor>`,
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "reconnect" || arg === "restart") {
				if (!state.phase) { ctx.ui.notify("No active plan to recover.", "info"); return; }
				if (!ctx.isIdle()) { ctx.ui.notify("Stop the current turn before recovering goal supervision.", "warning"); return; }
				readyAttempt = undefined;
				try {
					await restoreModel(state.phase === "planning" ? "planning" : "worker", ctx);
					if (arg === "restart") {
						if (!(await stopSupervisor())) throw new Error("Could not close the tracked supervisor pane; no replacement was opened.");
						state = { ...state, supervisorPaneId: null, approvalId: null };
						persist();
					}
					if (state.phase === "working" || state.supervisorPaneId) {
						if (arg === "reconnect") {
							if (!state.approvalId) throw new Error("No saved supervision binding. Use /goals restart.");
							intercom.configure(state.approvalId, "worker", ctx, false);
							await intercom.waitReady(5000, { peerOnly: true });
						} else await startSupervisor(ctx);
					}
					if (intercom.ended) return;
					if (state.phase === "working") {
						intercom.markReady();
						startWorkerTimers(ctx);
						await publishWorkerView(ctx, "settled");
					}
					ctx.ui.notify(state.phase === "planning" ? "Planning model restored. Choose Ready when the plan is agreed." : "Goal supervision reconnected; the current plan is unchanged.", "info");
				} catch (error) {
					if (intercom.ended) return;
					ctx.ui.notify(`Goal recovery failed: ${String(error)} Use /goals reconnect to retry, or /goals restart to explicitly replace the tracked pane.`, "warning");
				}
				updateWidget(ctx);
				return;
			}
			if (arg === "clear") {
				if (state.planVersion === null) {
					ctx.ui.notify("No active plan to disconnect.", "info");
					return;
				}
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
			if (arg === "model" || arg.startsWith("model ")) {
				if (state.phase === "working") {
					ctx.ui.notify("Run /goals clear before changing the active supervisor model.", "warning");
					return;
				}
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
			if (!(await stopSupervisor())) {
				ctx.ui.notify("Could not close the visible supervisor; no new plan was started.", "warning");
				return;
			}
			await restoreModel("planning", ctx);
			state = { ...state, phase: "planning", supervisorPaneId: null, approvalId: null, planVersion: nextVersion(ctx), latestDirection: arg };
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
		const paused = pauseReason();
		if (paused) return { systemPrompt: `${ctx.getSystemPrompt()}\n\nGoal work is paused: ${paused} Do not implement or sign off goals. Human input and read-only diagnosis remain available; wait for recovery before resuming autonomous work.` };
		if (state.phase === "working") {
			return {
				systemPrompt: `${ctx.getSystemPrompt()}\n\nYou are the implementation worker for ${planRel(ctx)}. Keep the full conversation and do the work directly. A stronger read-only supervisor watches this session through pi-intercom and can steer you. Commit clean evidence before asking for sign-off. Stop when a goal appears complete so the supervisor can inspect a settled worker view. Call CompleteGoal only after the supervisor says it recorded approval. -- PI[Kimi K3]`,
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
		if (event.source === "extension") return;
		state = { ...state, latestDirection: event.text };
		persist();
		if (state.phase === "planning") writePlan(ctx, appendInterview(readPlan(ctx), event.text));
	});

	pi.on("agent_start", async (_event, ctx) => {
		await publishWorkerView(ctx, "started");
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateWidget(ctx);
		if (state.phase !== "working") return;
		workerTurns++;
		if (workerTurns < 50) return;
		workerTurns = 0;
		await publishWorkerView(ctx, "turns");
	});

	pi.on("tool_call", async (event, ctx) => {
		const paused = pauseReason();
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
		if (state.phase === "planning") planningContextPending = true;
		else resyncReason = "The session was just compacted.";
	});

	// PI: Print after Pi settles. agent_end is still streaming, so its message queues behind the menu.
	pi.on("agent_settled", async (_event, ctx) => {
		if (state.phase === "working") {
			await publishWorkerView(ctx, "settled");
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
			try {
				await startSupervisor(ctx, current);
				if (!current()) return;
				await restoreModel("worker", ctx);
				if (!current()) return;
				state = { ...state, phase: "working" };
				resyncReason = "The plan was approved.";
				persist();
				intercom.markReady();
				startWorkerTimers(ctx);
				await publishWorkerView(ctx, "ready");
				if (!current()) return;
				updateWidget(ctx);
				ctx.ui.notify(`Visible supervisor opened in Herdr pane ${state.supervisorPaneId}.`, "info");
				pi.sendUserMessage("The plan is approved. Begin implementation as the worker.");
			} catch (error) {
				if (!current()) return;
				intercom.markNotReady();
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
			supervisorModel: last?.data?.supervisorModel ?? null,
			supervisorPaneId: last?.data?.supervisorPaneId ?? null,
			approvalId: last?.data?.approvalId ?? null,
			planVersion: last?.data?.planVersion ?? null,
			latestDirection: last?.data?.latestDirection ?? "",
		};
		modelError = state.phase ? "Role model restoration is pending." : null;
		planningContextPending = state.phase === "planning";
		resyncReason = state.phase === "working" ? "New session." : null;
		if (state.phase === "working" && state.approvalId) {
			intercom.configure(state.approvalId, "worker", ctx, false);
			startWorkerTimers(ctx);
		}
		try {
			if (state.phase) await restoreModel(state.phase === "planning" ? "planning" : "worker", ctx);
		} catch (error) {
			if (!intercom.ended) ctx.ui.notify(`Goal work paused: ${String(error)} Use /model, then /goals reconnect.`, "warning");
		}
		if (intercom.ended) return;
		if (state.phase === "working" && state.approvalId && !modelError) {
			intercom.markReady();
			void intercom.waitReady(5000).then(() => publishWorkerView(ctx, "settled")).catch(error => {
				if (!intercom.ended && state.phase === "working") ctx.ui.notify(`Goal work paused: ${String(error)} Use /goals reconnect or /goals restart.`, "warning");
			});
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (state.phase !== "working") return result("Planning is not approved. Choose Ready before signing off a goal.", true);
			if (pauseReason()) return result(`Goal sign-off blocked: ${pauseReason()}`, true);
			if (!state.approvalId) return result("Goal sign-off blocked: no current supervisor review.", true);
			const background = await backgroundState(pi);
			if (intercom.ended || !background.quiet || pauseReason()) return result(`Goal sign-off blocked: ${pauseReason() ?? background.description}`, true);
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
				approvalId: state.approvalId,
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
