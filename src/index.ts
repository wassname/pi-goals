// Pi/OpenAI: Plan and supervise in the main chat; delegate implementation to a visible worker.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { CronStorage } from "pi-schedule-prompt/src/storage.js";
import { Type } from "typebox";
import { FOLD_LINE, foldPlan, GOAL_LINE, goalAcceptanceSignature } from "./plan.js";
import { planViews } from "./plan-view.js";
import {
	attachGoalPlanDescription,
	attachNotice,
	childPlanAttached,
	childPlanRole,
	completeGoalDescription,
	completionLog,
	completionResult,
	discuss,
	emptyEvidence,
	evidenceUnavailable,
	goalToolBlocked,
	manualReview,
	messages,
	pausedRole,
	pauseExitNotice,
	planChangedReview,
	planContext,
	planDocument,
	planning,
	planningSeed,
	planUnavailable,
	readyApproved,
	removeGoalSchedule,
	resumeNotice,
	scheduleCheckIn,
	soloNotice,
	soloRole,
	supervisor,
	upkeep,
} from "./prompts.js";

const STATE = "pi-goals-main-supervisor-v1";
const WORKER = "goals-worker";
const WIDGET_GOAL_LIMIT = 3;
type Mode = "chat" | "planning" | "supervising" | "paused" | "solo";
type GoalStatus = "open" | "active" | "done" | "cancelled";
interface State {
	mode: Mode;
	plan?: string;
	worker?: { id?: string; sessionFile: string };
	helpers: { id?: string; sessionFile: string }[];
	workerStopped?: boolean;
	pausedFrom?: "solo" | "supervising";
	signoffs: Record<string, { evidence: string[]; observation: string; signature: string }>;
	child?: boolean;
}
const initial = (): State => ({ mode: "chat", helpers: [], signoffs: {} });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (text: string) => text.trim().toLowerCase();
function goals(text: string) {
	return foldPlan(text).split("\n").flatMap((line, index) => {
		const match = GOAL_LINE.exec(line);
		if (!match) return [];
		const box = match[1].toLowerCase();
		return [{ subject: match[2].trim(), status: (box === "x" ? "done" : box === "/" ? "active" : box === "-" ? "cancelled" : "open") as GoalStatus, index }];
	});
}
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function mainSupervisor(pi: ExtensionAPI) {
	let state = initial();
	let generation = 0;
	let workerRevision = 0;
	const pendingLaunches = new Map<string, { plan: string; generation: number; launches: { agent?: string; sessionFile?: string }[] }>();
	let notice = true;
	let planWatcher: FSWatcher | undefined;
	let planEditTimer: ReturnType<typeof setTimeout> | undefined;
	let planHash = "";
	const childEnvironment = process.env.PI_SUBAGENT_AGENT === WORKER;
	const save = () => pi.appendEntry(STATE, structuredClone(state));
	// Missing, empty and failed reads are unavailable snapshots, never an empty authoritative plan.
	const readPlan = () => {
		try {
			if (!state.plan) throw new Error(messages.noPlan);
			const text = readFileSync(state.plan, "utf8");
			if (!text.trim()) throw new Error(messages.emptyPlan);
			return { text };
		} catch (error) { return { error: planUnavailable(state.plan, error) }; }
	};
	const planText = () => {
		const snapshot = readPlan();
		if (snapshot.text === undefined) throw new Error(snapshot.error);
		return snapshot.text;
	};
	let turnsStale = 0;
	let upkeepRound = 0;
	let lastWorkingSet = "";
	let pendingUpkeep: { generation: number; workingSet: string } | undefined;
	const checkIn = (ctx: ExtensionContext) => scheduleCheckIn(ctx.sessionManager.getSessionId(), state.plan ?? "");
	const hasScheduleTool = () => pi.getAllTools().some((tool) => tool.name === "schedule_prompt");
	const notedPlanValue = (prefix: string) => {
		const snapshot = readPlan();
		if (snapshot.text === undefined) return null;
		const m = new RegExp(`^\\-\\s*${prefix}:\\s*(.+)$`, "im").exec(foldPlan(snapshot.text));
		return m?.[1]?.trim() ?? null;
	};
	function refresh(ctx: ExtensionContext) {
		if (state.child || state.mode === "chat") { ctx.ui.setStatus("goals", undefined); ctx.ui.setWidget("goals", undefined); return; }
		const snapshot = readPlan();
		if (snapshot.text === undefined) {
			ctx.ui.setStatus("goals", snapshot.error);
			ctx.ui.setWidget("goals", [snapshot.error]);
			return;
		}
		const items = goals(snapshot.text);
		// Pi/OpenAI: approval belongs to the reviewed requirements, not only the title.
		for (const subject of Object.keys(state.signoffs)) {
			const matches = items.filter((g) => key(g.subject) === subject);
			if (matches.length !== 1 || matches[0].status !== "done" || state.signoffs[subject].signature !== goalAcceptanceSignature(snapshot.text, subject)) { delete state.signoffs[subject]; save(); }
		}
		const accepted = items.filter((g) => g.status === "done" && state.signoffs[key(g.subject)]).length;
		ctx.ui.setStatus("goals", `👀 ${accepted}/${items.length} goals`);
		const mark = (status: GoalStatus) => status === "done" ? "✔" : status === "active" ? "◼" : status === "cancelled" ? "✗" : "◻";
		const lines = items.slice(0, WIDGET_GOAL_LIMIT).map((g, index) => `${mark(g.status)} G${index + 1}: ${g.subject}`);
		ctx.ui.setWidget("goals", lines);
	}
	function watchPlan(ctx: ExtensionContext) {
		planWatcher?.close();
		planWatcher = undefined;
		clearTimeout(planEditTimer);
		planEditTimer = undefined;
		const snapshot = readPlan();
		if (snapshot.text !== undefined) planHash = digest(planViews(snapshot.text).notify);
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
				const hash = digest(planViews(snapshot.text).notify);
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
		state.helpers ??= []; // sessions persisted before helper bookkeeping
		notice = true;
		turnsStale = 0;
		upkeepRound = 0;
		lastWorkingSet = "";
		pendingUpkeep = undefined;
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
		else pi.sendMessage({ customType: "pi-goals-supervision", content, display: true }, { deliverAs: "nextTurn" });
	}
	async function confirmOwnership(ctx: ExtensionContext, target: string, text: string, solo = true): Promise<boolean> {
		if (pendingLaunches.size > 0) { ctx.ui.notify("A worker launch/resume is still pending; inspect its result before takeover.", "warning"); return false; }
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
	const help = "/goals new [initial idea] | edit | discuss | review | ready | status | stop | resume | solo | attach <plan.md> [solo] | model <model> | quit (exit/clear)\n/subagents opens the worker controls. Stop pauses work. Quit/exit/clear backs up the plan and clears goal state without a model call; worker processes are unchanged. No forced compaction or model switch; the worker pane's own model is chosen with /model in that pane. Hourly check-ins are one session-bound schedule_prompt job; plan-change reviews are the plan-watcher event hook.";
	async function ready(ctx: ExtensionContext, menu: boolean, edit = false) {
		if (state.mode !== "planning") { ctx.ui.notify("Ready applies to a draft; use status or resume.", "warning"); return; }
		const text = planText();
		const items = goals(text);
		if (!edit && (!items.length || items.some(g => !g.subject) || new Set(items.map((g) => key(g.subject))).size !== items.length)) {
			ctx.ui.notify("Write a plan with distinct '- [ ] goal: ...' subjects before Ready.", "warning"); return;
		}
		const stamp = generation;
		if (menu || edit) {
			const choice = edit ? "Edit" : await ctx.ui.select(`Review ${state.plan}`, ["Ready", "Discuss", "Edit", "Cancel"]);
			if (stamp !== generation || digest(planText()) !== digest(text)) { ctx.ui.notify("Plan changed during review. Review it again.", "warning"); return; }
			if (choice === "Discuss") { send(discuss); return; }
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
	// Only successful compaction needs resync; failed/cancelled attempts leave pending context alone.
	// Defer to prompt preparation: same-run continuation retains Pi's current role/context.
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
			// In Pi 0.85.1 triggerTurn:false updates saved history, not the live loop snapshot.
			// Queue intent locally until ordinary prompt preparation, never force another turn.
			pendingUpkeep = { generation, workingSet };
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
			? supervisor(WORKER, state.plan!, ctx.sessionManager.getSessionId())
			: state.mode === "planning" ? planning(state.plan!) : state.mode === "paused" ? pausedRole : soloRole;
		// Returned messages enter both Pi's prompt snapshot and saved history together.
		// Unlike nextTurn, retaining intent here lets a fresh plan resync supersede upkeep,
		// and drops obsolete reminders after edits, takeover, pause or session navigation.
		const message = notice
			? { customType: "pi-goals-plan", content: planContext(state.child ? "worker" : state.mode, state.plan, snapshot.text), display: false }
			: pendingUpkeep?.generation === generation && pendingUpkeep.workingSet === foldPlan(snapshot.text)
				&& ["supervising", "solo"].includes(state.mode) && goals(snapshot.text).some(g => g.status === "open" || g.status === "active")
				? { customType: "pi-goals-upkeep", content: upkeep(state.plan!, state.mode === "supervising" ? upkeepRound : undefined), display: false } : undefined;
		if (message?.customType === "pi-goals-upkeep" && state.mode === "supervising") upkeepRound++;
		if (message) turnsStale = 0;
		notice = false;
		pendingUpkeep = undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${role}`, ...(message ? { message } : {}) };
	});
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "subagent" && event.input) {
			const prefix = `${basename(ctx.cwd)} · `;
			const launches = Array.isArray(event.input.children) ? event.input.children : [event.input];
			for (const launch of launches) {
				if (launch && typeof launch.title === "string" && !launch.title.startsWith(prefix)) launch.title = prefix + launch.title;
			}
		}
		if (state.child || (event.toolName !== "subagent" && event.toolName !== "subagent_resume")) return;
		// Solo means this chat took over implementation: no concurrent writer may be delegated.
		if (state.mode === "planning" || state.mode === "paused" || state.mode === "solo") return { block: true, reason: goalToolBlocked(state.mode) };
		if (state.plan) {
			const input = event.input as { agent?: string; sessionFile?: string; children?: { agent?: string; sessionFile?: string }[] };
			const launches = input.children ?? [input];
			pendingLaunches.set(event.toolCallId, { plan: state.plan, generation, launches: launches.map(launch => ({ agent: launch.agent, sessionFile: launch.sessionFile })) });
			state.workerStopped = false; workerRevision++; save();
		}
	});
	pi.on("tool_execution_end", (event) => {
		const pending = pendingLaunches.get(event.toolCallId);
		pendingLaunches.delete(event.toolCallId);
		if (!pending || state.child || pending.plan !== state.plan || pending.generation !== generation || event.isError) return;
		type ChildResult = { id?: string; sessionFile?: string; agent?: string };
		const details = (event.result as { details?: ChildResult & { children?: ChildResult[] } }).details;
		if (!details) return;
		for (const [index, child] of (details.children ?? [details]).entries()) {
			if (!child.id || !child.sessionFile) continue;
			const record = { id: child.id, sessionFile: child.sessionFile };
			const launch = pending.launches[index];
			const implementation = (child.agent ?? launch?.agent) === WORKER || launch?.sessionFile === state.worker?.sessionFile && Boolean(state.worker);
			if (state.worker?.sessionFile === record.sessionFile || !state.worker && implementation) state.worker = record;
			else state.helpers = [...state.helpers.filter(h => h.sessionFile !== record.sessionFile), record];
		}
		workerRevision++; save();
	});

	pi.registerCommand("goals", {
		description: "Goal plan actions: new, edit, discuss, review, ready, status, stop, resume, solo, attach, model, quit (exit/clear)",
		getArgumentCompletions: (prefix) => ["new", "attach", "edit", "discuss", "review", "ready", "status", "stop", "resume", "solo", "model", "help", "exit", "clear", "quit"].filter((verb) => verb.startsWith(prefix)).map((verb) => ({ value: verb, label: verb })),
		handler: async (args, ctx) => {
			try {
				if (state.child) { ctx.ui.notify("This is the delegated worker. Goal approval belongs to its parent.", "info"); return; }
				let command = args.trim();
				if (!command) {
					const actions = [
						...({
							chat: ["new — New plan", "attach — Open plan…"],
							planning: ["edit — Edit plan…", "discuss — Discuss changes to the plan", "ready — Approve draft"],
							supervising: ["review — Check progress", "stop — Pause work"],
							paused: ["resume — Resume work"],
							solo: ["stop — Pause work"],
						})[state.mode],
						...(["planning", "supervising", "paused"].includes(state.mode) ? ["model — Settings: worker model"] : []),
						"help — Show commands", "quit — Exit and clear goals",
					];
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
				if (command === "quit" || command === "clear") command = "exit";
				if (command === "help") { ctx.ui.notify(help, "info"); return; }
				if (command === "status") {
					refresh(ctx);
					ctx.ui.notify([
						`Mode: ${state.mode}`,
						`Plan: ${state.plan ?? "none"}`,
						`Preferred worker model (plan): ${notedPlanValue("preferred worker model") ?? "not stated; use /goals model <model>"}`,
						`Recorded worker session: ${state.worker?.sessionFile ?? "not recorded"}`,
						`Helper subagent sessions: ${state.helpers.length} recorded (liveness via /subagents)`,
						notedPlanValue("worker session") ? `Worker session noted in plan: ${notedPlanValue("worker session")}` : "",
						`Hourly check-in: schedule_prompt job ${JSON.stringify(`goals-${ctx.sessionManager.getSessionId()}`)} (list/remove via schedule_prompt; plan-change reviews are the plan-watcher event hook)`,
						"Liveness is owned by edxeth; inspect /subagents.",
					].filter(Boolean).join("\n"), "info");
					return;
				}
				if (command === "discuss") {
					if (state.mode !== "planning") { ctx.ui.notify("Discuss applies to a draft.", "warning"); return; }
					send(discuss); return;
				}
				if (command === "review" && state.mode === "supervising") { notice = true; send(manualReview(state.plan ?? "")); return; }
				if (command === "edit" || command === "review" || command === "ready") { await ready(ctx, command === "review", command === "edit"); return; }
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
					planHash = digest(planViews(planText()).notify);
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
					if (!goals(text).length || goals(text).some(g => !g.subject)) { ctx.ui.notify(`${target} has no '- [ ] goal:' lines with valid subjects; attach a judgeable plan.`, "warning"); return; }
					if (!solo && ((state.worker && !state.workerStopped) || state.mode === "supervising")) { ctx.ui.notify("Exit and resolve the existing worker before replacing the plan. The current plan is preserved.", "warning"); return; }
					const noted = /^-\s*worker session:\s*(\S+)/im.exec(foldPlan(text))?.[1];
					if (!(await confirmOwnership(ctx, target, text, solo))) return;
					const retained = target === state.plan ? state.signoffs : {};
					const worker = noted ? { sessionFile: resolve(ctx.cwd, noted) } : state.workerStopped ? state.worker : undefined;
					state = { mode: solo ? "solo" : "planning", plan: target, signoffs: retained, worker, helpers: [], workerStopped: solo || (!noted && state.workerStopped) };
					generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
					if (solo) enterSolo(ctx);
					else send(attachNotice(target, false, noted));
					return;
				}
				if (command === "exit") {
					const backup = state.plan && existsSync(state.plan) ? `${state.plan}.${randomUUID()}.bak` : undefined;
					if (backup) writeFileSync(backup, readFileSync(state.plan!), { flag: "wx" });
					const storage = new CronStorage(ctx.cwd);
					const session = ctx.sessionManager.getSessionId();
					for (const job of storage.getAllJobs().filter(j => j.name === `goals-${session}` && j.session === session)) {
						storage.removeJob(job.id); // Scheduler re-reads storage before firing; removed jobs cannot prompt.
						pi.events.emit("cron:change", { type: "remove", jobId: job.id });
					}
					state = initial(); generation++; workerRevision++; pendingLaunches.clear(); pendingUpkeep = undefined; notice = true;
					save(); refresh(ctx); watchPlan(ctx);
					ctx.ui.notify(`Goals cleared.${backup ? ` Plan backed up to ${backup}.` : ""}`, "info");
					return;
				}
				if (command === "stop") {
					if (state.mode === "planning") { ctx.ui.notify("A draft cannot pause; use /goals quit to back up and clear it.", "warning"); return; }
					if (state.mode !== "solo" && state.mode !== "supervising") return;
					state.pausedFrom = state.mode;
					state.mode = "paused"; generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
					const pause = pauseExitNotice(state.worker, false);
					const requestCleanup = Boolean(state.worker) || hasScheduleTool();
					if (!requestCleanup) ctx.ui.notify(pause, "info"); // Visible now; passive model context waits for a prompt.
					send(`${removeGoalSchedule(ctx.sessionManager.getSessionId())}\n\n${pause}`, requestCleanup);
					return;
				}
				if (command === "resume") {
					if (state.mode !== "paused" || !state.plan) { ctx.ui.notify("Only a paused approved plan can resume. A draft needs Ready.", "warning"); return; }
					if (state.pausedFrom === "solo") { enterSolo(ctx); return; }
					if (!compatible()) { ctx.ui.notify("edxeth tools unavailable; plan remains paused.", "error"); return; }
					state.mode = "supervising"; generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
					send(`${checkIn(ctx)}\n\n${resumeNotice(WORKER, state.plan, state.worker)}`);
					return;
				}
				if (command === "solo") {
					if (!state.plan || !goals(planText()).length || goals(planText()).some(g => !g.subject)) { ctx.ui.notify("Register a goal plan first.", "warning"); return; }
					if (!(await confirmOwnership(ctx, state.plan, planText()))) return;
					enterSolo(ctx);
					return;
				}
				if (command !== "new" && !command.startsWith("new ")) { ctx.ui.notify(`Unknown or incomplete command. ${help}`, "warning"); return; }
				const objective = command.slice(4).trim();
				if ((state.worker && !state.workerStopped) || state.mode === "supervising") { ctx.ui.notify("Exit and resolve the existing worker before replacing the plan. The current plan is preserved.", "warning"); return; }
				let path = join(ctx.cwd, ".pi", "plan", `${ctx.sessionManager.getSessionId()}-main.md`);
				mkdirSync(dirname(path), { recursive: true });
				try { writeFileSync(path, planDocument(objective), { flag: "wx" }); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					path = join(dirname(path), `${ctx.sessionManager.getSessionId()}-${randomUUID()}.md`);
					writeFileSync(path, planDocument(objective), { flag: "wx" });
				}
				state = { mode: "planning", plan: path, signoffs: {}, worker: state.worker, helpers: state.helpers, workerStopped: state.workerStopped }; generation++; notice = true; save(); refresh(ctx); watchPlan(ctx);
				send(planningSeed(objective, path));
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});
	pi.registerTool({
		name: "AttachGoalPlan", label: "Attach delegated plan", description: attachGoalPlanDescription,
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			if (!state.child) return result(messages.childAttachOnly);
			try {
				if (!isAbsolute(params.path)) return result(messages.invalidAttachment);
				const items = goals(readFileSync(params.path, "utf8"));
				if (!items.length || items.some(g => !g.subject)) return result(messages.invalidAttachment);
			} catch { return result(messages.invalidAttachment); }
			state.plan = params.path; generation++; notice = true; save(); refresh(ctx);
			return result(childPlanAttached(params.path));
		},
	});
	pi.registerTool({
		name: "CompleteGoal", label: "Review goal evidence",
		description: completeGoalDescription,
		parameters: Type.Object({ goal: Type.String({ minLength: 1 }), evidence: Type.Array(Type.String(), { minItems: 1 }), observation: Type.String({ minLength: 1 }) }),
		async execute(_id, params, signal, _update, ctx) {
			if (state.child || !state.plan || !["supervising", "solo"].includes(state.mode)) return result(messages.completionUnavailable);
			const path = state.plan;
			const stamp = generation;
			return withFileMutationQueue(path, async () => {
				if (stamp !== generation || path !== state.plan || state.child || !["supervising", "solo"].includes(state.mode)) return result(messages.completionUnavailable);
				if (signal?.aborted) return result(messages.cancelled);
				if (!params.goal.trim()) return result(messages.uniqueGoal);
				const snapshot = readPlan();
				if (snapshot.text === undefined) return result(snapshot.error!);
				const text = snapshot.text;
				const matches = goals(text).filter((g) => g.status !== "cancelled" && key(g.subject) === key(params.goal));
				if (matches.length !== 1 || !state.plan) return result(messages.uniqueGoal);
				const evidence = params.evidence.map((file) => isAbsolute(file) ? file : resolve(ctx.cwd, file));
				try { for (const file of evidence) if (!readFileSync(file).length) throw new Error(emptyEvidence(file)); }
				catch (error) { return result(evidenceUnavailable(error)); }
				const lines = text.split("\n");
				lines[matches[0].index] = lines[matches[0].index].replace(/\[[ xX/-]\]/, "[x]");
				let log = lines.findIndex(line => FOLD_LINE.test(line));
				if (log === -1) { lines.push("", "## Log"); log = lines.length - 1; }
				lines.splice(log + 1, 0, "", completionLog(params.goal, params.observation, evidence, state.mode === "solo"));
				writeFileSync(path, `${lines.join("\n").trimEnd()}\n`);
				state.signoffs[key(matches[0].subject)] = { evidence, observation: params.observation, signature: goalAcceptanceSignature(text, matches[0].subject)! };
				planHash = digest(planViews(planText()).notify);
				save(); refresh(ctx);
				const remaining = goals(planText()).some((goal) => goal.status !== "cancelled" && (goal.status !== "done" || !state.signoffs[key(goal.subject)]));
				return result(completionResult(matches[0].subject, ctx.sessionManager.getSessionId(), remaining, state.mode === "solo"));
			});
		},
	});
}
