/** Opt-in prototype: the existing chat plans and supervises an edxeth interactive worker. */
import { createHash } from "node:crypto";
import { type FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { foldPlan, GOAL_LINE } from "./plan.js";
import { planViews } from "./plan-view.js";
import {
	attachGoalPlanDescription,
	attachNotice,
	childPlanAttached,
	childPlanRole,
	completionLog,
	completionResult,
	emptyEvidence,
	evidenceUnavailable,
	goalToolBlocked,
	manualReview,
	pausedRole,
	pauseExitNotice,
	planChangedReview,
	planUnavailable,
	prototypeCompleteGoalDescription,
	prototypeDiscuss,
	prototypeMessages,
	prototypePlanContext,
	prototypePlanDocument,
	prototypePlanning,
	prototypePlanningSeed,
	prototypeSupervisor,
	prototypeUpkeep,
	readyApproved,
	removeGoalSchedule,
	resumeNotice,
	scheduleCheckIn,
	soloNotice,
	soloRole,
} from "./prompts.js";

const STATE = "pi-goals-main-supervisor-v1";
const WORKER = "goals-worker";
type Mode = "chat" | "planning" | "supervising" | "paused" | "solo";
type GoalStatus = "open" | "active" | "done" | "cancelled";
interface State {
	mode: Mode;
	plan?: string;
	worker?: { id?: string; sessionFile: string };
	workerStopped?: boolean;
	signoffs: Record<string, { evidence: string[]; observation: string }>;
	child?: boolean;
}
const initial = (): State => ({ mode: "chat", signoffs: {} });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (text: string) => text.trim().toLowerCase();
const SUBTASK_LINE = /^\s+(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*(.*)$/;
function goals(text: string) {
	return foldPlan(text).split("\n").flatMap((line, index) => {
		const match = GOAL_LINE.exec(line);
		if (!match) return [];
		const box = match[1].toLowerCase();
		return [{ subject: match[2].trim(), status: (box === "x" ? "done" : box === "/" ? "active" : box === "-" ? "cancelled" : "open") as GoalStatus, index }];
	});
}
/** Open subtasks under the goal at goalLine, up to the next goal line; the widget shows these. */
function openSubtasks(plan: string, goalLine: number): string[] {
	const lines = foldPlan(plan).split("\n");
	const out: string[] = [];
	for (let i = goalLine + 1; i < lines.length; i++) {
		if (GOAL_LINE.test(lines[i])) break;
		const m = SUBTASK_LINE.exec(lines[i]);
		if (m && (m[1] === " " || m[1] === "/")) out.push(m[2].trim());
	}
	return out;
}
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function mainSupervisor(pi: ExtensionAPI) {
	let state = initial();
	let generation = 0;
	let workerRevision = 0;
	let launchPending = false;
	let notice = true;
	let planWatcher: FSWatcher | undefined;
	let planEditTimer: ReturnType<typeof setTimeout> | undefined;
	let planHash = "";
	const childEnvironment = process.env.PI_SUBAGENT_AGENT === WORKER;
	const save = () => pi.appendEntry(STATE, state);
	// Missing, empty and failed reads are unavailable snapshots, never an empty authoritative plan.
	const readPlan = () => {
		try {
			if (!state.plan) throw new Error(prototypeMessages.noPlan);
			const text = readFileSync(state.plan, "utf8");
			if (!text.trim()) throw new Error(prototypeMessages.emptyPlan);
			return { text };
		} catch (error) { return { error: planUnavailable(state.plan, error) }; }
	};
	const planText = () => {
		const snapshot = readPlan();
		if (snapshot.text === undefined) throw new Error(snapshot.error);
		return snapshot.text;
	};
	let turnsStale = 0;
	let lastWorkingSet = "";
	const checkIn = (ctx: ExtensionContext) => scheduleCheckIn(ctx.sessionManager.getSessionId(), state.plan ?? "");
	const hasScheduleTool = () => pi.getAllTools().some((tool) => tool.name === "schedule_prompt");
	const notedPlanValue = (prefix: string) => {
		const snapshot = readPlan();
		if (snapshot.text === undefined) return null;
		const m = new RegExp(`^\\-\\s*${prefix}:\\s*(.+)$`, "im").exec(foldPlan(snapshot.text));
		return m?.[1]?.trim() ?? null;
	};
	function refresh(ctx: ExtensionContext) {
		if (state.mode === "chat") { ctx.ui.setStatus("goals", undefined); ctx.ui.setWidget("goals", undefined); return; }
		const snapshot = readPlan();
		if (snapshot.text === undefined) {
			ctx.ui.setStatus("goals", snapshot.error);
			ctx.ui.setWidget("goals", [snapshot.error]);
			return;
		}
		const items = goals(snapshot.text);
		// Reopened/deleted/ambiguous goal identities lose their sign-off. Manual ticks remain claims.
		for (const subject of Object.keys(state.signoffs)) {
			const matches = items.filter((g) => key(g.subject) === subject);
			if (matches.length !== 1 || matches[0].status !== "done") { delete state.signoffs[subject]; save(); }
		}
		const accepted = items.filter((g) => g.status === "done" && state.signoffs[key(g.subject)]).length;
		ctx.ui.setStatus("goals", `goals: ${state.child ? "worker" : state.mode} | ${accepted}/${items.length} reviewed`);
		// Progress and subtask visibility: the widget is the task list, so the active goal shows its
		// next open subtasks without reading archived checkboxes below the fold.
		const plan = snapshot.text;
		const focus = items.find((g) => g.status === "active") ?? items.find((g) => g.status === "open" && openSubtasks(plan, g.index).length > 0);
		const mark = (status: GoalStatus, signed: boolean) => status === "done" ? (signed ? "✓" : "?") : status === "active" ? "▸" : status === "cancelled" ? "✗" : "○";
		const lines: string[] = items.map((g) => `${mark(g.status, Boolean(state.signoffs[key(g.subject)]))} ${g.subject}`);
		if (focus) {
			const muted = (s: string) => ctx.ui.theme.fg("muted", `   ◦ ${s}`);
			lines.push(...openSubtasks(plan, focus.index).slice(0, 3).map(muted));
		}
		if (items.some((g) => g.status === "done" && !state.signoffs[key(g.subject)])) lines.push("? = completion claim; parent review still required");
		ctx.ui.setWidget("goals", lines);
	}
	function watchPlan(ctx: ExtensionContext) {
		planWatcher?.close();
		planWatcher = undefined;
		clearTimeout(planEditTimer);
		planEditTimer = undefined;
		const snapshot = readPlan();
		if (snapshot.text !== undefined) planHash = digest(planViews(snapshot.text).short);
		if (state.child || state.mode !== "supervising" || !state.plan) return;
		const stamp = generation;
		// Watch the directory so atomic plan replacement remains observable. This is an event hook:
		// plan-change reviews, not another scheduled loop (the hourly job is schedule_prompt's). A
		// short debounce coalesces bursts. Existing high-level plan views exclude maintenance
		// (tasks/evidence/Log) while preserving requirement wording and goal checkbox claims.
		try {
			planWatcher = watch(dirname(state.plan), { persistent: false }, () => {
			if (stamp !== generation) return;
			if (planEditTimer) clearTimeout(planEditTimer);
			planEditTimer = setTimeout(() => {
				planEditTimer = undefined;
				if (stamp !== generation || state.mode !== "supervising") return;
				const snapshot = readPlan();
				if (snapshot.text === undefined) { ctx.ui.notify(snapshot.error!, "warning"); return; }
				refresh(ctx);
				const hash = digest(planViews(snapshot.text).short);
				if (hash === planHash) return;
				planHash = hash;
				notice = true;
				send(planChangedReview(state.plan!));
			}, 150);
		});
		planWatcher.on("error", (error) => { planWatcher?.close(); planWatcher = undefined; ctx.ui.notify(`Plan monitoring failed: ${error.message}`, "error"); });
		} catch (error) { ctx.ui.notify(`Plan monitoring unavailable: ${String(error)}`, "error"); }
	}
	function restore(ctx: ExtensionContext) {
		generation++;
		state = initial();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE) state = structuredClone(entry.data as State);
		}
		if (childEnvironment) {
			state.child = true;
			state.mode = "solo";
			// Lineage-only workers attach the explicit task path using AttachGoalPlan.
			save();
		}
		notice = true;
		turnsStale = 0;
		lastWorkingSet = "";
		refresh(ctx);
		watchPlan(ctx);
	}
	function compatible() {
		const tools = pi.getAllTools();
		const properties = (name: string) => (tools.find((t) => t.name === name)?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
		return properties("subagent")?.title && properties("subagent")?.agent && properties("subagent_resume")?.sessionFile && properties("subagent_kill")?.id;
	}
	function send(content: string, triggerTurn = true) {
		// sendMessage(triggerTurn:true) bypasses before_agent_start in Pi 0.85.1.
		// A normal saved prompt prepares the current role before starting the turn.
		if (triggerTurn) pi.sendUserMessage(`[pi-goals]\n${content}`, { deliverAs: "followUp" });
		else pi.sendMessage({ customType: "pi-goals-supervision", content, display: true }, { deliverAs: "followUp", triggerTurn: false });
	}
	async function confirmOwnership(ctx: ExtensionContext, target: string, text: string, solo = true): Promise<boolean> {
		if (launchPending) { ctx.ui.notify("Worker launch/resume is still pending; inspect its result before takeover.", "warning"); return false; }
		const stamp = generation;
		const revision = workerRevision;
		const confirmation = solo ? "Worker confirmed stopped" : "Previous supervisor confirmed stopped";
		const choice = await ctx.ui.select(solo ? "Confirm all other writers for the current and target plans are stopped (inspect /subagents and their panes). A missing handle is not proof. Take over in this session?" : "Confirm no other supervisor owns this plan. Preserve any existing worker session and reconnect rather than starting another writer.", [confirmation, "Cancel"]);
		if (stamp !== generation || revision !== workerRevision) return false;
		if (choice !== confirmation) return false;
		if (readFileSync(target, "utf8") !== text) { ctx.ui.notify("Plan changed during takeover; confirm again.", "warning"); return false; }
		return true;
	}
	function enterSolo(ctx: ExtensionContext) {
		state.mode = "solo"; state.workerStopped = true;
		generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
		send(`${removeGoalSchedule(ctx.sessionManager.getSessionId())}\n\n${soloNotice(state.plan!)}`);
	}
	const help = "/goals new [initial idea] | review | ready | status | stop | resume | solo | exit | attach <plan.md> [solo] | model <model>\n/subagents opens the worker controls. Stop/exit pause this plan locally; worker termination must be confirmed through subagent_kill or its pane. No forced compaction or model switch; the worker pane's own model is chosen with /model in that pane. Hourly check-ins are one session-bound schedule_prompt job; plan-change reviews are the plan-watcher event hook.";
	async function ready(ctx: ExtensionContext, menu: boolean) {
		if (state.mode !== "planning") { ctx.ui.notify("Ready applies to a draft; use status or resume.", "warning"); return; }
		const text = planText();
		const items = goals(text);
		if (!items.length || new Set(items.map((g) => key(g.subject))).size !== items.length) {
			ctx.ui.notify("Write a plan with distinct '- [ ] goal: ...' subjects before Ready.", "warning"); return;
		}
		const stamp = generation;
		if (menu) {
			const choice = await ctx.ui.select(`Review ${state.plan}`, ["Ready", "Discuss", "Edit", "Cancel"]);
			if (stamp !== generation || digest(planText()) !== digest(text)) { ctx.ui.notify("Plan changed during review. Review it again.", "warning"); return; }
			if (choice === "Discuss") { send(prototypeDiscuss); return; }
			if (choice === "Edit") {
				const edited = await ctx.ui.editor("Edit goal plan", text);
				if (edited !== undefined && stamp === generation && planText() === text && state.plan) { writeFileSync(state.plan, edited); refresh(ctx); }
				return;
			}
			if (choice !== "Ready") return;
		}
		if (!compatible()) { ctx.ui.notify("Requires edxeth/pi-subagents 2.9.x, not nicobailon/pi-subagents. Draft preserved; /goals solo is available.", "error"); return; }
		state.mode = "supervising"; generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
		send(`${checkIn(ctx)}\n\n${readyApproved(WORKER, state.plan!, state.worker?.sessionFile, text, ctx.sessionManager.getSessionId())}`);
	}

	pi.on("session_start", (_e, ctx) => restore(ctx));
	pi.on("session_tree", (_e, ctx) => restore(ctx));
	pi.on("session_shutdown", () => { generation++; planWatcher?.close(); planWatcher = undefined; clearTimeout(planEditTimer); planEditTimer = undefined; });
	pi.on("session_compact", () => { notice = true; });
	pi.on("turn_end", (_event, ctx) => {
		if (!["supervising", "solo"].includes(state.mode)) return;
		const snapshot = readPlan();
		if (snapshot.text === undefined) { notice = true; return; }
		const workingSet = foldPlan(snapshot.text);
		turnsStale = workingSet === lastWorkingSet ? turnsStale + 1 : 0;
		lastWorkingSet = workingSet;
		refresh(ctx);
		if (turnsStale === 8 && goals(snapshot.text).some(g => g.status === "open" || g.status === "active")) {
			// Pi queues context-only messages until tool results are appended at turn_end.
			// This reaches the next model call in a long run without triggering another run.
			pi.sendMessage({ customType: "pi-goals-upkeep", content: prototypeUpkeep(state.plan!), display: false }, { triggerTurn: false });
		}
	});
	pi.on("agent_end", (_e, ctx) => { refresh(ctx); if (!planWatcher && state.mode === "supervising") watchPlan(ctx); });
	let proposedDraft = "";
	let proposing = false;
	pi.on("agent_settled", async (_e, ctx) => {
		if (state.child || state.mode !== "planning" || !ctx.hasUI || proposing) return;
		const text = planText();
		const version = `${state.plan}:${digest(text)}`;
		if (!goals(text).length || version === proposedDraft) return;
		proposedDraft = version;
		proposing = true;
		try {
			pi.sendMessage({ customType: "goal-plan-proposal", content: text, display: true }, { triggerTurn: false });
			await ready(ctx, true);
		} finally { proposing = false; }
	});
	// No context hook. Historical message arrays, native checkpoints and model selection are untouched.
	pi.on("before_agent_start", (event, ctx) => {
		if (state.mode === "chat") return;
		const snapshot = readPlan();
		if (snapshot.text === undefined) {
			notice = true; // Retry resync on the next turn; do not consume a failed snapshot.
			return { systemPrompt: `${event.systemPrompt}\n\n${state.child ? childPlanRole : ""}\n${snapshot.error}` };
		}
		const role = state.child ? childPlanRole : state.mode === "supervising"
			? prototypeSupervisor(WORKER, state.plan!, ctx.sessionManager.getSessionId())
			: state.mode === "planning" ? prototypePlanning(state.plan!) : state.mode === "paused" ? pausedRole : soloRole;
		const content = notice ? prototypePlanContext(state.child ? "worker" : state.mode, state.plan, snapshot.text)
			: undefined;
		if (content) turnsStale = 0;
		notice = false;
		return { systemPrompt: `${event.systemPrompt}\n\n${role}`, ...(content ? { message: { customType: "pi-goals-plan", content, display: false } } : {}) };
	});
	pi.on("tool_call", (event) => {
		if (state.child || !["subagent", "subagent_resume"].includes(event.toolName)) return;
		// Solo means this chat took over implementation: no concurrent writer may be delegated.
		if (state.mode === "planning" || state.mode === "paused" || state.mode === "solo") return { block: true, reason: goalToolBlocked(state.mode) };
		if (state.plan) { launchPending = true; state.workerStopped = false; workerRevision++; save(); }
	});
	pi.on("tool_result", (event) => {
		if (state.child || !state.plan || !["subagent", "subagent_resume"].includes(event.toolName)) return;
		launchPending = false;
		if (event.isError) return;
		const details = event.details as { id?: string; sessionFile?: string } | undefined;
		if (details?.id && details.sessionFile) { state.worker = { id: details.id, sessionFile: details.sessionFile }; state.workerStopped = false; workerRevision++; save(); }
	});

	pi.registerCommand("goals", {
		description: "Goal plan actions: new, review, ready, status, stop, resume, solo, attach, model, exit",
		getArgumentCompletions: (prefix) => ["new", "review", "ready", "status", "stop", "resume", "solo", "attach", "model", "exit", "help"].filter((verb) => verb.startsWith(prefix)).map((verb) => ({ value: verb, label: verb })),
		handler: async (args, ctx) => {
			try {
				if (state.child) { ctx.ui.notify("This is the delegated worker. Goal approval belongs to its parent.", "info"); return; }
				let command = args.trim();
				if (!command) {
					const actions = ["status — Show current plan", "new — New plan", "attach — Open an existing plan", "review — Review current plan", "ready — Approve draft", "stop — Pause work", "resume — Continue paused work", "solo — Work in this session", "model — Set worker model", "exit — Leave goal mode", "help — Show commands"];
					const before = generation;
					const choice = await ctx.ui.select("Goal plan actions", actions);
					if (!choice || before !== generation) return;
					command = choice.split(" — ")[0];
					if (["attach", "model"].includes(command)) {
						const value = await ctx.ui.editor(command === "attach" ? "Plan path (optional: solo)" : "Worker model (provider/model)", "");
						if (!value?.trim() || before !== generation) return;
						command += ` ${value.trim()}`;
					}
				}
				if (command === "help") { ctx.ui.notify(help, "info"); return; }
				if (command === "status") {
					refresh(ctx);
					ctx.ui.notify([
						`Mode: ${state.mode}`,
						`Plan: ${state.plan ?? "none"}`,
						`Preferred worker model (plan): ${notedPlanValue("preferred worker model") ?? "not stated; use /goals model <model>"}`,
						`Recorded worker session: ${state.worker?.sessionFile ?? "not recorded"}`,
						notedPlanValue("worker session") ? `Worker session noted in plan: ${notedPlanValue("worker session")}` : "",
						`Hourly check-in: schedule_prompt job ${JSON.stringify(`goals-${ctx.sessionManager.getSessionId()}`)} (list/remove via schedule_prompt; plan-change reviews are the plan-watcher event hook)`,
						"Liveness is owned by edxeth; inspect /subagents.",
					].filter(Boolean).join("\n"), "info");
					return;
				}
				if (command === "review" && state.mode === "supervising") { notice = true; send(manualReview(state.plan ?? "")); return; }
				if (command === "review" || command === "ready") { await ready(ctx, command === "review"); return; }
				if (command === "model" || command.startsWith("model ")) {
					if (!state.plan || !goals(planText()).length) { ctx.ui.notify("Register a goal plan first.", "warning"); return; }
					const ref = command.slice("model".length).trim();
					if (!ref) { ctx.ui.notify("Use /goals model <provider/model>; no preference changed.", "info"); return; }
					const lines = planText().split("\n");
					const pref = `- preferred worker model: ${ref || "(none specified)"}`;
					const found = lines.findIndex((line) => /^-\s*preferred worker model:/i.test(line));
					if (found >= 0) lines[found] = pref;
					else { const title = lines.findIndex((line) => /^#\s/.test(line)); lines.splice(title >= 0 ? title + 1 : 0, 0, pref); }
					writeFileSync(state.plan, lines.join("\n"));
					planHash = digest(planViews(planText()).short);
					refresh(ctx);
					ctx.ui.notify(ref ? `Preferred worker model set to ${ref} in plan preferences. The supervisor selects it at launch and verifies the resolved model; the worker pane's own model is chosen with /model in that pane.` : "Preferred worker model cleared.", "info");
					return;
				}
				if (command === "attach" || command.startsWith("attach ")) {
					const rest = command.slice("attach".length).trim();
					const [raw, kind, extra] = rest.split(/\s+/);
					const solo = kind === "solo";
					if (extra || (kind && !solo)) { ctx.ui.notify("Use /goals attach <path-to-plan.md> [solo].", "warning"); return; }
					if (!raw) { ctx.ui.notify("Use /goals attach <path-to-plan.md> [solo].", "info"); return; }
					const target = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
					let text: string;
					try { text = readFileSync(target, "utf8"); } catch { ctx.ui.notify(`Cannot read plan at ${target}.`, "error"); return; }
					if (!goals(text).length) { ctx.ui.notify(`${target} has no '- [ ] goal:' lines; attach a judgeable plan.`, "warning"); return; }
					if (!solo && ((state.worker && !state.workerStopped) || state.mode === "supervising")) { ctx.ui.notify("Exit and resolve the existing worker before replacing the plan. The current plan is preserved.", "warning"); return; }
					const noted = /^-\s*worker session:\s*(\S+)/im.exec(foldPlan(text))?.[1];
					if (!(await confirmOwnership(ctx, target, text, solo))) return;
					const retained = target === state.plan ? state.signoffs : {};
					const worker = noted ? { sessionFile: resolve(ctx.cwd, noted) } : state.workerStopped ? state.worker : undefined;
					state = { mode: solo ? "solo" : "planning", plan: target, signoffs: retained, worker, workerStopped: solo || (!noted && state.workerStopped) };
					generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
					if (solo) enterSolo(ctx);
					else send(attachNotice(target, false, noted));
					return;
				}
				if (command === "stop" || command === "exit") {
					if (state.mode === "planning") {
						if (command === "stop") { ctx.ui.notify("A draft cannot pause; use /goals exit to leave planning with the draft preserved.", "warning"); return; }
						// Planning exit must not get the model trapped re-planning or lose the draft.
						state.mode = "chat"; generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
						ctx.ui.notify(`Planning exited; draft preserved at ${state.plan}. No implementation was approved or started. Reconnect with /goals attach ${state.plan}.`, "info");
						return;
					}
					state.mode = command === "stop" ? "paused" : "chat"; generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
					send(`${removeGoalSchedule(ctx.sessionManager.getSessionId())}\n\n${pauseExitNotice(state.worker, command === "exit")}`, Boolean(state.worker) || hasScheduleTool());
					return;
				}
				if (command === "resume") {
					if (state.mode !== "paused" || !state.plan) { ctx.ui.notify("Only a paused approved plan can resume. A draft needs Ready.", "warning"); return; }
					if (!compatible()) { ctx.ui.notify("edxeth tools unavailable; plan remains paused.", "error"); return; }
					state.mode = "supervising"; generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
					send(`${checkIn(ctx)}\n\n${resumeNotice(WORKER, state.plan, state.worker)}`);
					return;
				}
				if (command === "solo") {
					if (!state.plan || !goals(planText()).length) { ctx.ui.notify("Register a goal plan first.", "warning"); return; }
					if (!(await confirmOwnership(ctx, state.plan, planText()))) return;
					enterSolo(ctx);
					return;
				}
				if (command !== "new" && !command.startsWith("new ")) { ctx.ui.notify(`Unknown or incomplete command. ${help}`, "warning"); return; }
				const objective = command.slice(4).trim();
				if ((state.worker && !state.workerStopped) || state.mode === "supervising") { ctx.ui.notify("Exit and resolve the existing worker before replacing the plan. The current plan is preserved.", "warning"); return; }
				const path = join(ctx.cwd, ".pi", "plan", `${ctx.sessionManager.getSessionId()}-main.md`);
				mkdirSync(dirname(path), { recursive: true });
				// Never overwrite an earlier plan at this session path; the model can revise it after inspection.
				try { writeFileSync(path, prototypePlanDocument(objective), { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
				state = { mode: "planning", plan: path, signoffs: {}, worker: state.worker, workerStopped: state.workerStopped }; generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
				send(prototypePlanningSeed(objective, path));
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});
	pi.registerTool({
		name: "AttachGoalPlan", label: "Attach delegated plan", description: attachGoalPlanDescription,
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			if (!state.child) return result(prototypeMessages.childAttachOnly);
			try {
				if (!isAbsolute(params.path) || !goals(readFileSync(params.path, "utf8")).length) return result(prototypeMessages.invalidAttachment);
			} catch { return result(prototypeMessages.invalidAttachment); }
			state.plan = params.path; generation++; notice = true; save(); refresh(ctx);
			return result(childPlanAttached(params.path));
		},
	});
	pi.registerTool({
		name: "CompleteGoal", label: "Review goal evidence",
		description: prototypeCompleteGoalDescription,
		parameters: Type.Object({ goal: Type.String(), evidence: Type.Array(Type.String(), { minItems: 1 }), observation: Type.String({ minLength: 1 }) }),
		async execute(_id, params, signal, _update, ctx) {
			if (state.child || !["supervising", "solo"].includes(state.mode)) return result(prototypeMessages.completionUnavailable);
			if (signal?.aborted) return result(prototypeMessages.cancelled);
			const snapshot = readPlan();
			if (snapshot.text === undefined) return result(snapshot.error!);
			const text = snapshot.text;
			const matches = goals(text).filter((g) => g.status !== "cancelled" && key(g.subject) === key(params.goal));
			if (matches.length !== 1 || !state.plan) return result(prototypeMessages.uniqueGoal);
			const evidence = params.evidence.map((file) => isAbsolute(file) ? file : resolve(ctx.cwd, file));
			try { for (const file of evidence) if (!readFileSync(file).length) throw new Error(emptyEvidence(file)); }
			catch (error) { return result(evidenceUnavailable(error)); }
			const lines = text.split("\n");
			lines[matches[0].index] = lines[matches[0].index].replace(/\[[ xX/-]\]/, "[x]");
			let log = lines.findIndex(line => /^##\s+Log\s*$/i.test(line));
			if (log === -1) { lines.push("", "## Log"); log = lines.length - 1; }
			lines.splice(log + 1, 0, "", completionLog(params.goal, params.observation, evidence, state.mode === "solo"));
			writeFileSync(state.plan, `${lines.join("\n").trimEnd()}\n`);
			state.signoffs[key(matches[0].subject)] = { evidence, observation: params.observation };
			planHash = digest(planViews(planText()).short);
			save(); refresh(ctx);
			const remaining = goals(planText()).some((goal) => goal.status !== "cancelled" && (goal.status !== "done" || !state.signoffs[key(goal.subject)]));
			return result(completionResult(matches[0].subject, ctx.sessionManager.getSessionId(), remaining, state.mode === "solo"));
		},
	});
}
