// Pi/OpenAI: Plan and supervise in the main chat; delegate implementation to a visible worker.
import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { INTERCOM_EXTENSION_REGISTER_EVENT, type IntercomExtensionChannel, type IntercomExtensionRegistration } from "pi-intercom/extension-api.js";
import { CronStorage } from "pi-schedule-prompt/src/storage.js";
import { openProjectPane } from "pi-subagents/project-panes";
import { Type } from "typebox";
import { noticeDisplay } from "./notice-display.js";
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
	finalReview,
	finalReviewInvalidated,
	finalReviewQueued,
	goalToolBlocked,
	manualReview,
	messages,
	nativeMessages,
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
	workerAssignment,
	workerReview,
} from "./prompts.js";

const STATE = "pi-goals-main-supervisor-v1";
const WORKER = "goals-worker";
const CONTROL = "goals-worker-control";
const WIDGET_GOAL_LIMIT = 3;
type Mode = "chat" | "planning" | "supervising" | "paused" | "solo";
type GoalStatus = "open" | "active" | "done" | "cancelled";
interface Peer {
	sessionId: string; sessionFile: string; leafId: string | null; paneId: string;
	durable: boolean; empty: boolean; started?: boolean; parentSession?: string; plan?: string; parentId?: string; requestId?: string; model?: string;
}
interface WorkerRequest {
	id: string; action: "start" | "fresh" | "recover"; task?: string; model?: string;
	reviewedThrough?: string; writersStopped?: boolean; sessionFile?: string; savedDigest?: string; savedId?: string; savedIntercom?: string;
	phase: "probe" | "control" | "switch"; previous?: Peer;
}
interface State {
	mode: Mode;
	plan?: string;
	worker?: { sessionFile?: string; intercomId?: string; paneId?: string; requestId?: string; parentId?: string; identity?: Peer; pending?: WorkerRequest };
	parent?: { intercomId: string; requestId: string; selfId?: string; started?: boolean };
	workerStopped?: boolean;
	pausedFrom?: "solo" | "supervising";
	signoffs: Record<string, { evidence: string[]; observation: string; signature: string }>;
	finalReview?: { planDigest: string };
	child?: boolean;
	lastControl?: string;
}
const initial = (): State => ({ mode: "chat", signoffs: {} });
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
const requirements = (text: string) => goals(text).map(g => goalAcceptanceSignature(text, g.subject)).join("\n");
function savedWorker(path: string) {
	const text = readFileSync(path, "utf8");
	const entries = text.trim().split("\n").map(line => JSON.parse(line));
	const header = entries[0];
	if (header?.type !== "session" || typeof header.id !== "string" || !entries.some(entry => entry.message?.role === "assistant")) throw new Error(nativeMessages.notDurable);
	const state = entries.filter(entry => entry.type === "custom" && entry.customType === STATE).at(-1)?.data as State | undefined;
	if (!state?.child || !state.parent) throw new Error(nativeMessages.notOwned);
	return { header, state, digest: digest(text) };
}
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function mainSupervisor(pi: ExtensionAPI) {
	const notices = noticeDisplay(pi);
	let state = initial();
	let generation = 0;
	let workerRevision = 0;
	let finalReviewTurnDigest: string | undefined;
	let opening = false;
	let channel: IntercomExtensionChannel | undefined;
	let ownIntercomId: string | undefined;
	let liveContext: ExtensionContext | undefined;
	let control: { from: string; request: WorkerRequest; plan: string; expected: Peer; cancelled?: boolean } | undefined;
	let replacing: "new" | "resume" | undefined;
	let notice = true;
	let fullPlanContextDue = true;
	let planWatcher: FSWatcher | undefined;
	let planEditTimer: ReturnType<typeof setTimeout> | undefined;
	let planHash = "";
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
	const clearChangedFinalReview = (text: string) => {
		if (!state.finalReview || state.finalReview.planDigest === digest(text)) return false;
		state.finalReview = undefined;
		finalReviewTurnDigest = undefined;
		save();
		return true;
	};
	let turnsStale = 0;
	let lastWorkingSet = "";
	let pendingPlanNotice: string | undefined;
	let pendingUpkeep: { generation: number; workingSet: string } | undefined;
	const unfinishedGoals = (text: string) => foldPlan(text).split("\n").filter(line => {
		const match = GOAL_LINE.exec(line);
		return match && match[1] !== "-" && !(match[1].toLowerCase() === "x" && state.signoffs[key(match[2])] && state.signoffs[key(match[2])].signature === goalAcceptanceSignature(text, match[2]));
	}).join("\n");
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
		const mark = (status: GoalStatus) => status === "done" ? "✓" : status === "active" ? "◼" : status === "cancelled" ? "✗" : "◻";
		const priority: Record<GoalStatus, number> = { active: 0, open: 1, done: 2, cancelled: 3 };
		const sorted = [...items].sort((a, b) => priority[a.status] - priority[b.status]);
		const visible = sorted.slice(0, WIDGET_GOAL_LIMIT);
		const lines = visible.map((g) => `${mark(g.status)} G${items.indexOf(g) + 1}: ${g.subject}`);
		const hidden = sorted.slice(WIDGET_GOAL_LIMIT);
		if (hidden.length) {
			const counts = (["done", "active", "open", "cancelled"] as const).map(status => {
				const count = hidden.filter(g => g.status === status).length;
				return count ? `${count} ${mark(status)}` : "";
			}).filter(Boolean);
			lines.push(`… ${counts.join(", ")}`);
		}
		const planPath = relative(ctx.cwd, state.plan!);
		const external = isAbsolute(planPath) || planPath === ".." || planPath.startsWith(`..${sep}`);
		lines.unshift(external ? `${basename(state.plan!)} (external)` : planPath);
		ctx.ui.setWidget("goals", lines);
	}
	function watchPlan(ctx: ExtensionContext) {
		pendingPlanNotice = undefined;
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
		// short debounce coalesces bursts. The notification view excludes Log and worker identity;
		// requirement changes additionally request active-plan context.
		try {
			planWatcher = watch(dirname(state.plan), { persistent: false }, () => {
			if (stamp !== generation) return;
			if (planEditTimer) clearTimeout(planEditTimer);
			planEditTimer = setTimeout(() => {
				planEditTimer = undefined;
				if (stamp !== generation || state.mode !== "supervising") return;
				const snapshot = readPlan();
				if (snapshot.text === undefined) { ctx.ui.notify(snapshot.error!, "warning"); return; }
				clearChangedFinalReview(snapshot.text);
				refresh(ctx);
				const hash = digest(planViews(snapshot.text).notify);
				if (hash === planHash) return;
				planHash = hash;
				notice = true;
				fullPlanContextDue ||= requirements(snapshot.text) !== requirements(lastWorkingSet);
				if (!pendingPlanNotice) { pendingPlanNotice = planChangedReview(state.plan!); send(pendingPlanNotice); }
			}, 150);
		});
		planWatcher.on("error", (error) => { planWatcher?.close(); planWatcher = undefined; ctx.ui.notify(`Plan monitoring failed: ${error.message}`, "error"); });
		} catch (error) { ctx.ui.notify(`Plan monitoring unavailable: ${String(error)}`, "error"); }
	}
	function restore(ctx: ExtensionContext) {
		notices.restore(ctx);
		generation++;
		state = initial();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE) state = structuredClone(entry.data as State);
		}
		notice = true;
		turnsStale = 0;
		lastWorkingSet = "";
		pendingUpkeep = undefined;
		finalReviewTurnDigest = undefined;
		fullPlanContextDue = true;
		refresh(ctx);
		watchPlan(ctx);
	}
	function send(content: string, triggerTurn = true) {
		// sendMessage(triggerTurn:true) bypasses before_agent_start in Pi 0.85.1.
		// A normal saved prompt prepares the current role before starting the turn.
		if (triggerTurn) {
			const prompt = `[pi-goals]\n${content}`;
			notices.mirror(prompt);
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} else pi.sendMessage({ customType: "pi-goals-supervision", content, display: true }, { deliverAs: "nextTurn" });
	}
	async function confirmOwnership(ctx: ExtensionContext, target: string, text: string, solo = true): Promise<boolean> {
		if (opening || state.worker?.pending) { ctx.ui.notify("A worker launch/resume is still pending; inspect its result before takeover.", "warning"); return false; }
		const stamp = generation;
		const revision = workerRevision;
		const confirmation = solo ? "Worker confirmed stopped" : "Previous supervisor confirmed stopped";
		const choice = await ctx.ui.select(solo ? "Confirm all other writers for the current and target plans are stopped (inspect Intercom and their native panes). A missing handle is not proof. Take over in this session?" : "Confirm no other supervisor owns this plan. Preserve any existing worker session and reconnect rather than starting another writer.", [confirmation, "Cancel"]);
		if (stamp !== generation || revision !== workerRevision) return false;
		if (choice !== confirmation) return false;
		if (readFileSync(target, "utf8") !== text) { ctx.ui.notify("Plan changed during takeover; confirm again.", "warning"); return false; }
		return true;
	}
	function enterSolo(ctx: ExtensionContext) {
		state.mode = "solo"; state.workerStopped = true;
		generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx); watchPlan(ctx);
		send(`${removeGoalSchedule(ctx.sessionManager.getSessionId())}\n\n${soloNotice(state.plan!)}`);
	}
	const help = "/goals new [initial idea] | edit | discuss | review | ready | status | stop | resume | solo | attach <plan.md> [solo] | model <model> | quit (exit/clear)\nOpenGoalWorker opens a native project pane; use Intercom to steer the verified worker session. Stop pauses work. Quit/exit/clear preserves the plan and clears goal state without a model call; worker processes are unchanged. No forced compaction or model switch; the worker pane's own model is chosen with /model in that pane. Hourly check-ins are one session-bound schedule_prompt job; plan-change reviews are the plan-watcher event hook.";
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
			if (choice === "Discuss") { ctx.ui.notify(discuss, "info"); return; }
			if (choice === "Edit") {
				const edited = await ctx.ui.editor("Edit goal plan", text);
				if (edited !== undefined && stamp === generation && planText() === text && state.plan) { writeFileSync(state.plan, edited); refresh(ctx); }
				return;
			}
			if (choice !== "Ready") return;
		}
		state.mode = "supervising"; generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx); watchPlan(ctx);
		send(`${checkIn(ctx)}\n\n${readyApproved(WORKER, state.plan!, state.worker?.sessionFile, text, ctx.sessionManager.getSessionId())}`);
	}

	function identity(ctx: ExtensionContext): Peer {
		const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
		let durable = false;
		try { durable = savedWorker(sessionFile).header.id === ctx.sessionManager.getSessionId(); } catch { /* A prospective path is not saved history. */ }
		return { sessionId: ctx.sessionManager.getSessionId(), sessionFile, leafId: ctx.sessionManager.getLeafId(), paneId: process.env.HERDR_PANE_ID ?? "", durable,
			empty: !ctx.sessionManager.getBranch().some(entry => entry.type === "message"), parentSession: ctx.sessionManager.getHeader()?.parentSession,
			plan: state.plan, parentId: state.parent?.intercomId, requestId: state.parent?.requestId, started: state.parent?.started, model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : undefined };
	}
	const publish = (payload: unknown) => { channel?.publish(payload, { audience: "capable" }); };
	async function available() {
		const stamp = generation, ctx = liveContext, current = channel;
		if (!ctx || !current?.snapshot().connected || !current.snapshot().supported) return;
		const peers = await current.listSessions().catch(() => []);
		if (stamp !== generation || current !== channel) return;
		const self = peers.filter(peer => peer.pid === process.pid);
		if (self.length === 1 && pi.getCommands().some(command => command.name === CONTROL)) { ownIntercomId = self[0].id; publish({ type: "available", identity: identity(ctx) }); }
	}
	function probe() {
		if (state.mode === "supervising" && state.worker?.pending && state.worker.paneId) publish({ type: "inspect", paneId: state.worker.paneId, requestId: state.worker.pending.id });
	}
	function cancelControl() {
		if (control) control.cancelled = true;
		if (state.worker?.pending) {
			try { publish({ type: "cancel", paneId: state.worker.paneId, requestId: state.worker.pending.id }); } catch { /* Local pause still takes effect when the peer is disconnected. */ }
			state.worker.requestId = state.worker.pending.previous?.requestId ?? state.worker.requestId;
			state.worker.pending = undefined;
		}
	}
	function registerChannel(ctx: ExtensionContext) {
		liveContext = ctx;
		const registration: IntercomExtensionRegistration = {
			namespace: "pi-goals", ownerEligible: false,
			onReady: (value) => { channel = value; void available(); },
			onEvent: (event) => {
				if (event.type === "connection" && event.connected) { void available(); probe(); }
				if (event.type === "session_left" && event.sessionId === state.worker?.intercomId && state.mode === "supervising" && state.worker.pending?.phase !== "switch") send(workerReview(state.plan!, event.sessionId, nativeMessages.disconnected));
				if (event.type !== "message" || !event.payload || typeof event.payload !== "object") return;
				const data = event.payload as { type?: string; to?: string; requestId?: string; plan?: string; paneId?: string; sessionFile?: string; text?: string; identity?: Peer; request?: WorkerRequest; expected?: Peer };
				if (data.type === "inspect" && data.paneId && data.paneId === process.env.HERDR_PANE_ID && typeof data.requestId === "string") {
					publish({ type: "peer", to: event.fromSessionId, requestId: data.requestId, identity: identity(ctx) }); return;
				}
				if (data.type === "cancel" && data.paneId === process.env.HERDR_PANE_ID && control?.from === event.fromSessionId && data.requestId === control.request.id) { control.cancelled = true; return; }
				if (data.type === "control" && ownIntercomId && data.to === ownIntercomId && data.expected && data.expected.paneId === process.env.HERDR_PANE_ID && data.request && ["start", "fresh", "recover"].includes(data.request.action) && typeof data.request.id === "string" && typeof data.plan === "string") {
					if (control || !pi.getCommands().some(command => command.name === CONTROL)) return;
					control = { from: event.fromSessionId, request: data.request, plan: data.plan, expected: data.expected };
					pi.sendUserMessage("/" + CONTROL, { expandPromptTemplates: true, deliverAs: "followUp" }); return;
				}
				const worker = state.worker, pending = worker?.pending;
				if (state.child || !worker || !state.plan) return;
				if (data.type === "available" && data.identity?.paneId === worker.paneId && pending) { probe(); return; }
				if (data.type === "peer" && pending && data.identity && data.to === worker.parentId && data.requestId === pending.id && data.identity.paneId === worker.paneId && state.mode === "supervising") {
					const peer = data.identity;
					if (event.fromSessionId === worker.parentId) return;
					if (peer.parentId === worker.parentId && peer.requestId === pending.id && peer.started) { worker.intercomId = event.fromSessionId; worker.identity = peer; worker.sessionFile = peer.sessionFile; worker.requestId = pending.id; worker.pending = undefined; save(); send(workerReview(state.plan, event.fromSessionId, nativeMessages.actionApplied("observed without replay", peer))); return; }
					if (pending.phase === "control") return;
					if (pending.phase === "probe" && pending.action === "fresh" && (peer.sessionId !== pending.previous?.sessionId || peer.sessionFile !== pending.previous?.sessionFile)) { worker.pending = undefined; save(); send(workerReview(state.plan, event.fromSessionId, nativeMessages.controlChanged)); return; }
					if (pending.phase === "switch") {
						const arrived = pending.action === "fresh" ? peer.sessionId !== pending.previous?.sessionId && peer.parentSession === pending.previous?.sessionFile && peer.requestId === pending.id : peer.sessionId === pending.savedId && peer.sessionFile === pending.sessionFile;
						if (!arrived) return;
					}
					worker.intercomId = event.fromSessionId; worker.identity = peer; worker.sessionFile = peer.sessionFile;
					const phase = pending.phase; pending.phase = "control"; workerRevision++; save();
					publish({ type: "control", to: event.fromSessionId, plan: state.plan, expected: peer, request: { ...pending, action: phase === "switch" || pending.action === "recover" && peer.sessionId === pending.savedId ? "start" : pending.action } }); return;
				}
				if (!worker.parentId || !data.requestId || data.to !== worker.parentId || event.fromSessionId === data.to || (data.requestId !== worker.requestId && data.requestId !== pending?.id) || data.plan !== state.plan) return;
				if (data.type === "switching" && event.fromSessionId === worker.intercomId && pending && data.requestId === pending.id) { pending.phase = "switch"; save(); return; }
				if (data.type === "rejected" && event.fromSessionId === worker.intercomId && pending && data.requestId === pending.id) { worker.requestId = pending.previous?.requestId ?? worker.requestId; worker.pending = undefined; save(); send(workerReview(state.plan, event.fromSessionId, data.text ?? nativeMessages.controlRejected), state.mode === "supervising"); return; }
				if (data.type === "attached" && typeof data.sessionFile === "string" && isAbsolute(data.sessionFile) && (!worker.intercomId || worker.intercomId === event.fromSessionId)) {
					if (worker.pending && data.requestId !== worker.pending.id) { send(workerReview(state.plan, event.fromSessionId, nativeMessages.attached(data.sessionFile)), false); return; }
					const action = worker.pending?.action;
					worker.requestId = data.requestId;
					worker.intercomId = event.fromSessionId; worker.sessionFile = data.sessionFile; if (data.identity) worker.identity = data.identity; worker.pending = undefined; workerRevision++; save();
					send(workerReview(state.plan, event.fromSessionId, action ? nativeMessages.actionApplied(action, data.identity) : nativeMessages.attached(data.sessionFile)), Boolean(action) && state.mode === "supervising");
				}
				if (data.type === "stopped" && event.fromSessionId === worker.intercomId && typeof data.text === "string") {
					if (data.identity) { worker.identity = data.identity; worker.sessionFile = data.identity.sessionFile; save(); }
					send(workerReview(state.plan, event.fromSessionId, data.text), state.mode === "supervising");
				}
			},
		};
		pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, registration);
	}
	pi.registerCommand(CONTROL, {
		description: nativeMessages.controlDescription,
		handler: async (_args, ctx) => {
			const operation = control;
			if (!operation) return; // Never execute arbitrary slash-command payloads.
			const { request, expected, from, plan } = operation;
			const controlKey = request.id + ":" + request.action;
			if (state.lastControl === controlKey) { control = undefined; return; }
			let authorized = false;
			const reject = (text: string) => publish({ type: "rejected", to: from, requestId: request.id, plan, text });
			try {
				await ctx.waitForIdle();
				const current = identity(ctx);
				if (operation.cancelled || state.mode === "paused" && !(request.action === "start" && request.savedId === current.sessionId) || ctx.hasPendingMessages() || ctx.ui.getEditorText().length || current.sessionId !== expected.sessionId || current.leafId !== expected.leafId || current.sessionFile !== expected.sessionFile) throw new Error(nativeMessages.controlChanged);
				if (!isAbsolute(plan) || !goals(readFileSync(plan, "utf8")).length) throw new Error(messages.invalidAttachment);
				const peers = await channel?.listSessions();
				const self = peers?.find(peer => peer.pid === process.pid);
				if (!self || from === self.id || !peers?.some(peer => peer.id === from)) throw new Error(nativeMessages.parentUnavailable);
				if (operation.cancelled || ctx.hasPendingMessages() || ctx.ui.getEditorText().length || identity(ctx).leafId !== expected.leafId) throw new Error(nativeMessages.controlChanged);
				if (state.child && state.parent?.intercomId !== from || !state.child && (state.mode !== "chat" || !current.empty)) throw new Error(nativeMessages.notOwned);
				authorized = true;
				if (request.action === "start") {
					const recovering = request.savedId === current.sessionId;
					if (!recovering && (!current.empty || state.parent?.started)) throw new Error(nativeMessages.controlChanged);
					if (request.model) throw new Error(nativeMessages.modelRaceBoundary);
					state = { ...(recovering ? state : initial()), mode: recovering ? state.mode : "solo", child: true, plan, lastControl: controlKey, parent: { intercomId: from, requestId: request.id, selfId: self.id, started: true } };
					generation++; notice = true; fullPlanContextDue = true; save();
					publish({ type: "attached", to: from, requestId: request.id, plan, sessionFile: ctx.sessionManager.getSessionFile(), identity: identity(ctx) });
					if (!recovering && request.task) pi.sendUserMessage(workerAssignment(plan, from, request.id, request.task));
				} else {
					if (!current.empty && (!current.durable || request.reviewedThrough !== current.leafId)) throw new Error(nativeMessages.reviewRequired);
					if (request.action === "fresh" && (!state.child || !current.durable)) throw new Error(nativeMessages.notDurable);
					if (request.action === "recover") {
						if (!request.writersStopped || !request.sessionFile || !request.savedIntercom) throw new Error(nativeMessages.stopRequired);
						const saved = savedWorker(request.sessionFile);
						if (saved.digest !== request.savedDigest || saved.header.id !== request.savedId || saved.header.cwd !== ctx.cwd || saved.state.parent?.intercomId !== from || peers.some(peer => peer.id === request.savedIntercom && peer.id !== self.id)) throw new Error(nativeMessages.controlChanged);
					}
					publish({ type: "switching", to: from, requestId: request.id, plan });
					replacing = request.action === "fresh" ? "new" : "resume";
					const switched = request.action === "fresh"
						? await ctx.newSession({ parentSession: current.sessionFile, setup: async manager => { manager.appendCustomEntry(STATE, { ...initial(), mode: "solo", child: true, plan, parent: { intercomId: from, requestId: request.id } }); } })
						: await ctx.switchSession(request.sessionFile!);
					if (switched.cancelled) { replacing = undefined; state.lastControl = controlKey; save(); reject(nativeMessages.controlCancelled); }
				}
			} catch (error) { if (authorized) { state.lastControl = controlKey; save(); } reject(String(error)); }
			finally { replacing = undefined; control = undefined; }
		},
	});
	const reportStop = (text: string) => {
		if (!state.child || !state.parent) return;
		try {
			if (!channel?.snapshot().connected) throw new Error("disconnected");
			channel.publish({ type: "stopped", to: state.parent.intercomId, requestId: state.parent.requestId, plan: state.plan, text, identity: liveContext ? identity(liveContext) : undefined }, { audience: "capable" });
		} catch { send(nativeMessages.reportUnavailable, false); }
	};
	pi.on("session_start", (_e, ctx) => {
		restore(ctx); registerChannel(ctx);
	});
	pi.on("session_tree", (_e, ctx) => restore(ctx));
	pi.on("session_shutdown", (event) => { if (!replacing || event?.reason !== replacing) reportStop(nativeMessages.shuttingDown); channel = undefined; liveContext = undefined; ownIntercomId = undefined; generation++; finalReviewTurnDigest = undefined; planWatcher?.close(); planWatcher = undefined; clearTimeout(planEditTimer); planEditTimer = undefined; });
	// Only successful compaction needs resync; failed/cancelled attempts leave pending context alone.
	// Defer to prompt preparation: same-run continuation retains Pi's current role/context.
	pi.on("session_compact", () => { notice = true; fullPlanContextDue = true; });
	pi.on("turn_end", (_event, ctx) => {
		if (!["supervising", "solo"].includes(state.mode)) return;
		const snapshot = readPlan();
		if (snapshot.text === undefined) { notice = true; return; }
		const workingSet = foldPlan(snapshot.text);
		fullPlanContextDue ||= requirements(workingSet) !== requirements(lastWorkingSet);
		turnsStale = workingSet === lastWorkingSet ? turnsStale + 1 : 0;
		lastWorkingSet = workingSet;
		refresh(ctx);
		if (turnsStale === 8 && unfinishedGoals(snapshot.text)) {
			// In Pi 0.85.1 triggerTurn:false updates saved history, not the live loop snapshot.
			// Queue intent locally until ordinary prompt preparation, never force another turn.
			pendingUpkeep = { generation, workingSet };
		}
	});
	// Queued follow-ups can be consumed inside the same run, without before_agent_start.
	pi.on("message_end", (event) => {
		if (event.message.role !== "user") return;
		const content = typeof event.message.content === "string" ? event.message.content : event.message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		if (pendingPlanNotice && content === `[pi-goals]\n${pendingPlanNotice}`) pendingPlanNotice = undefined;
		if (!state.finalReview || !["supervising", "solo"].includes(state.mode)) return;
		const snapshot = readPlan();
		if (snapshot.text === undefined || state.finalReview.planDigest !== digest(snapshot.text)) return;
		if (content === `[pi-goals]\n${finalReview(state.plan!, snapshot.text)}`) finalReviewTurnDigest = state.finalReview.planDigest;
	});
	pi.on("agent_end", (event, ctx) => {
		const last = event.messages.filter(message => message.role === "assistant").at(-1);
		reportStop(last?.role === "assistant" ? last.errorMessage || last.content.filter(part => part.type === "text").map(part => part.text).join("\n") || last.stopReason : nativeMessages.noAssistant);
		finalReviewTurnDigest = undefined; refresh(ctx); if (!planWatcher && state.mode === "supervising") watchPlan(ctx); });
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
		clearChangedFinalReview(snapshot.text);
		const role = state.child ? childPlanRole + (state.mode === "paused" ? "\n" + pausedRole : "") : state.mode === "supervising"
			? supervisor(WORKER, state.plan!, ctx.sessionManager.getSessionId())
			: state.mode === "planning" ? planning(state.plan!) : state.mode === "paused" ? pausedRole : soloRole;
		fullPlanContextDue ||= requirements(snapshot.text) !== requirements(lastWorkingSet);
		const pendingFinalReview = ["supervising", "solo"].includes(state.mode) ? state.finalReview : undefined;
		if (pendingFinalReview) finalReviewTurnDigest = pendingFinalReview.planDigest;
		// Returned messages enter both Pi's prompt snapshot and saved history together.
		// Unlike nextTurn, retaining intent here lets a fresh plan resync supersede upkeep,
		// and drops obsolete reminders after edits, takeover, pause or session navigation.
		const message = pendingFinalReview
			? { customType: "pi-goals-final-review", content: finalReview(state.plan!, snapshot.text), display: false }
			: notice || fullPlanContextDue
				? { customType: "pi-goals-plan", content: planContext(state.child ? "worker" : state.mode, state.plan, fullPlanContextDue ? snapshot.text : unfinishedGoals(snapshot.text), fullPlanContextDue ? "full" : "short"), display: false }
				: pendingUpkeep?.generation === generation && pendingUpkeep.workingSet === foldPlan(snapshot.text)
				&& ["supervising", "solo"].includes(state.mode) && unfinishedGoals(snapshot.text)
				? { customType: "pi-goals-upkeep", content: upkeep(state.plan!, unfinishedGoals(snapshot.text)), display: false } : undefined;
		if (message) turnsStale = 0;
		notice = false;
		fullPlanContextDue = false;
		lastWorkingSet = foldPlan(snapshot.text);
		pendingUpkeep = undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${role}`, ...(message ? { message } : {}) };
	});
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent" && event.toolName !== "OpenGoalWorker") return;
		if (state.child || ["planning", "paused", "solo"].includes(state.mode)) return { block: true, reason: goalToolBlocked(state.child ? "worker" : state.mode) };
	});

	pi.registerCommand("goals", {
		description: "Goal plan actions: new, edit, discuss, review, ready, status, stop, resume, solo, attach, model, quit (exit/clear)",
		getArgumentCompletions: (prefix) => ["new", "attach", "edit", "discuss", "review", "ready", "status", "stop", "resume", "solo", "model", "help", "exit", "clear", "quit"].filter((verb) => verb.startsWith(prefix)).map((verb) => ({ value: verb, label: verb })),
		handler: async (args, ctx) => {
			try {
				if (state.child) {
					if (["stop", "resume"].includes(args.trim())) { cancelControl(); state.mode = args.trim() === "stop" ? "paused" : "solo"; generation++; save(); ctx.ui.notify(nativeMessages.workerPause(state.mode === "paused"), "info"); return; }
					ctx.ui.notify("This is the delegated worker. Goal approval belongs to its parent.", "info"); return;
				}
				let command = args.trim();
				if (!command) {
					const actions = [
						...({
							chat: ["new — New plan…", "attach — Open plan…"],
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
					if (command === "new") {
						const value = await ctx.ui.editor("Planning instructions (optional; blank uses this conversation)", "");
						if (value === undefined || before !== generation) return;
						command += ` ${value.trim()}`;
					}
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
						`Worker Intercom: ${state.worker?.intercomId ?? "unconfirmed"}; native pane: ${state.worker?.paneId ?? "unconfirmed"}`,
						notedPlanValue("worker session") ? `Worker session noted in plan: ${notedPlanValue("worker session")}` : "",
						`Hourly check-in: schedule_prompt job ${JSON.stringify(`goals-${ctx.sessionManager.getSessionId()}`)} (list/remove via schedule_prompt; plan-change reviews are the plan-watcher event hook)`,
						"Inspect the exact Intercom session and native pane; a binding or idle status is not completion.",
					].filter(Boolean).join("\n"), "info");
					return;
				}
				if (command === "discuss") {
					if (state.mode !== "planning") { ctx.ui.notify("Discuss applies to a draft.", "warning"); return; }
					ctx.ui.notify(discuss, "info"); return;
				}
				if (command === "review" && state.mode === "supervising") { send(manualReview(state.plan ?? "", unfinishedGoals(planText()))); return; }
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
					ctx.ui.notify(ref ? `Preferred worker model set to ${ref} in plan preferences. project.open has no model override; choose /model in the native worker pane and verify its resolved model.` : "Preferred worker model cleared.", "info");
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
					state = { mode: solo ? "solo" : "planning", plan: target, signoffs: retained, worker, workerStopped: solo || (!noted && state.workerStopped) };
					generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx); watchPlan(ctx);
					if (solo) enterSolo(ctx);
					else send(attachNotice(target, false, noted));
					return;
				}
				if (command === "exit") {
					cancelControl();
					const storage = new CronStorage(ctx.cwd);
					const session = ctx.sessionManager.getSessionId();
					const matching = storage.getAllJobs().filter(j => j.name === `goals-${session}`);
					const skipped = matching.filter(j => j.session !== session);
					if (skipped.length) ctx.ui.notify(`Goal check-ins left unchanged (session binding missing or different): ${skipped.map(j => j.id).join(", ")}. Inspect /schedule-prompt.`, "warning");
					for (const job of matching.filter(j => j.session === session)) {
						storage.removeJob(job.id); // Scheduler re-reads storage before firing; removed jobs cannot prompt.
						pi.events.emit("cron:change", { type: "remove", jobId: job.id });
					}
					state = initial(); generation++; workerRevision++; pendingUpkeep = undefined; notice = true;
					save(); refresh(ctx); watchPlan(ctx);
					ctx.ui.notify("Goals cleared; original plan file unchanged.", "info");
					return;
				}
				if (command === "stop") {
					if (state.mode === "planning") { ctx.ui.notify("A draft cannot pause; use /goals quit to clear goal state and preserve the draft.", "warning"); return; }
					if (state.mode !== "solo" && state.mode !== "supervising") return;
					cancelControl();
					state.pausedFrom = state.mode;
					state.mode = "paused"; generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx); watchPlan(ctx);
					const pause = pauseExitNotice(state.worker, false);
					const requestCleanup = Boolean(state.worker) || hasScheduleTool();
					if (!requestCleanup) ctx.ui.notify(pause, "info"); // Visible now; passive model context waits for a prompt.
					send(`${removeGoalSchedule(ctx.sessionManager.getSessionId())}\n\n${pause}`, requestCleanup);
					return;
				}
				if (command === "resume") {
					if (state.mode !== "paused" || !state.plan) { ctx.ui.notify("Only a paused approved plan can resume. A draft needs Ready.", "warning"); return; }
					if (state.pausedFrom === "solo") { enterSolo(ctx); return; }
					state.mode = "supervising"; generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx); watchPlan(ctx);
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
				const planDir = join(ctx.cwd, ".pi", "plan");
				mkdirSync(planDir, { recursive: true });
				const suffix = ctx.sessionManager.getSessionId().slice(-6);
				const pattern = new RegExp(`^${suffix}-v(\\d+)\\.md$`);
				let version = 1 + Math.max(0, ...readdirSync(planDir).map(name => Number(pattern.exec(name)?.[1] ?? 0)));
				let path: string;
				for (;;) {
					path = join(planDir, `${suffix}-v${version}.md`);
					try { writeFileSync(path, planDocument(objective), { flag: "wx" }); break; } catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						version++;
					}
				}
				state = { mode: "planning", plan: path, signoffs: {}, worker: state.worker, workerStopped: state.workerStopped }; generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx); watchPlan(ctx);
				send(planningSeed(objective, path));
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});
	pi.registerTool({
		name: "OpenGoalWorker", label: "Open native goal worker", description: nativeMessages.openDescription,
		parameters: Type.Object({ task: Type.Optional(Type.String()), action: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("fresh"), Type.Literal("recover")])), model: Type.Optional(Type.String()), reviewedThrough: Type.Optional(Type.String()), writersStopped: Type.Optional(Type.Boolean()), sessionFile: Type.Optional(Type.String()) }),
		async execute(_id, params, signal, _update, ctx) {
			if (state.child || state.mode !== "supervising" || !state.plan) return result(goalToolBlocked(state.mode));
			const action = params.action ?? "start";
			if (opening || state.worker?.pending || action === "start" && state.worker) return result(nativeMessages.alreadyRecorded);
			const preference = action === "recover" ? null : notedPlanValue("preferred worker model");
			if (params.model || preference && (preference.includes("/") || !/^(?:none|\(none|default|inherit|not stated)\b/i.test(preference))) return result(nativeMessages.modelRaceBoundary);
			if (action !== "recover" && !params.task) return result(nativeMessages.taskRequired);
			if (action === "fresh" && (!state.worker?.identity || !params.reviewedThrough)) return result(nativeMessages.reviewRequired);
			if (!channel?.snapshot().connected || !channel.snapshot().supported) return result(nativeMessages.intercomNotReady);
			const stamp = generation, plan = state.plan;
			const peers = await channel.listSessions().catch(() => undefined);
			if (!peers) return result(nativeMessages.intercomNotReady);
			const self = peers.filter(peer => peer.pid === process.pid);
			if (self.length !== 1) return result(nativeMessages.noIdentity);
			if (stamp !== generation || opening || signal?.aborted) return result(messages.cancelled);
			const requestId = randomUUID();
			const request: WorkerRequest = { id: requestId, action, task: params.task, model: params.model, reviewedThrough: params.reviewedThrough, writersStopped: params.writersStopped, phase: "probe", previous: state.worker?.identity };
			if (action === "recover") {
				if (!params.writersStopped || params.model || params.task) return result(nativeMessages.stopRequired);
				try {
					request.sessionFile = params.sessionFile || state.worker?.sessionFile;
					if (!request.sessionFile || !isAbsolute(request.sessionFile)) return result(nativeMessages.notDurable);
					const saved = savedWorker(request.sessionFile);
					request.savedId = saved.header.id; request.savedDigest = saved.digest;
					request.savedIntercom = saved.state.parent?.selfId ?? (request.sessionFile === state.worker?.sessionFile ? state.worker.intercomId : undefined);
					if (saved.header.cwd !== ctx.cwd || saved.state.plan !== plan || saved.state.parent?.intercomId !== self[0].id || !request.savedIntercom) return result(nativeMessages.notOwned);
				} catch (error) { return result(String(error)); }
			}
			state.worker = { ...state.worker, requestId: state.worker?.requestId ?? requestId, parentId: self[0].id, pending: request }; state.workerStopped = false; workerRevision++; opening = true; save();
			try {
				const pane = await openProjectPane({ cwd: ctx.cwd, focus: false, signal }); // No prompt before verified capability/model selection.
				if (pane.ok && state.plan === plan && state.worker?.pending?.id === requestId) { state.worker.paneId = pane.data.binding.paneId; save(); probe(); }
				return result(pane.ok ? JSON.stringify({ disposition: pane.data.disposition, paneId: pane.data.binding.paneId, projectRoot: pane.data.binding.projectRoot, bindingPath: pane.data.bindingPath }) + nativeMessages.openReceipt : JSON.stringify(pane));
			} catch (error) { return result(nativeMessages.openFailed + String(error)); }
			finally { opening = false; }
		},
	});
	pi.registerTool({
		name: "AttachGoalPlan", label: "Attach delegated plan", description: attachGoalPlanDescription,
		parameters: Type.Object({ path: Type.String(), parent: Type.Optional(Type.String()), requestId: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _update, ctx) {
			if (!state.child && (state.mode !== "chat" || !params.parent || !params.requestId)) return result(messages.childAttachOnly);
			if (state.child && state.plan && state.plan !== params.path) return result(messages.invalidAttachment);
			try {
				if (!isAbsolute(params.path)) return result(messages.invalidAttachment);
				const items = goals(readFileSync(params.path, "utf8"));
				if (!items.length || items.some(g => !g.subject)) return result(messages.invalidAttachment);
			} catch { return result(messages.invalidAttachment); }
			if (!state.child) {
				if (!channel?.snapshot().connected) return result(nativeMessages.intercomNotReady);
				const stamp = generation;
				const peers = await channel.listSessions().catch(() => undefined);
				if (!peers) return result(nativeMessages.intercomNotReady);
				if (stamp !== generation) return result(messages.cancelled);
				if (!peers?.some(peer => peer.id === params.parent && peer.pid !== process.pid)) return result(nativeMessages.parentUnavailable);
				state = { ...initial(), child: true, mode: "solo", parent: { intercomId: params.parent!, requestId: params.requestId!, selfId: peers.find(peer => peer.pid === process.pid)?.id, started: true } };
			}
			state.plan = params.path; generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx);
			if (state.parent) channel?.publish({ type: "attached", to: state.parent.intercomId, requestId: state.parent.requestId, plan: state.plan, sessionFile: ctx.sessionManager.getSessionFile(), identity: identity(ctx) }, { audience: "capable" });
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
				const subject = key(matches[0].subject);
				const othersAccepted = goals(text).every((goal) => goal.status === "cancelled" || key(goal.subject) === subject || (goal.status === "done" && state.signoffs[key(goal.subject)]));
				if (othersAccepted && !(matches[0].status === "done" && state.signoffs[subject])) {
					if (clearChangedFinalReview(text)) return result(finalReviewInvalidated);
					if (finalReviewTurnDigest !== digest(text)) {
						if (!state.finalReview) {
							state.finalReview = { planDigest: digest(text) };
							save();
							send(finalReview(path, text));
						}
						return result(finalReviewQueued(matches[0].subject));
					}
				}
				const lines = text.split("\n");
				lines[matches[0].index] = lines[matches[0].index].replace(/\[[ xX/-]\]/, "[x]");
				let log = lines.findIndex(line => FOLD_LINE.test(line));
				if (log === -1) { lines.push("", "## Log"); log = lines.length - 1; }
				lines.splice(log + 1, 0, "", completionLog(params.goal, params.observation, evidence, state.mode === "solo"));
				writeFileSync(path, `${lines.join("\n").trimEnd()}\n`);
				state.signoffs[key(matches[0].subject)] = { evidence, observation: params.observation, signature: goalAcceptanceSignature(text, matches[0].subject)! };
				state.finalReview = undefined;
				finalReviewTurnDigest = undefined;
				planHash = digest(planViews(planText()).notify);
				save(); refresh(ctx);
				const remaining = goals(planText()).some((goal) => goal.status !== "cancelled" && (goal.status !== "done" || !state.signoffs[key(goal.subject)]));
				return result(completionResult(matches[0].subject, ctx.sessionManager.getSessionId(), remaining, state.mode === "solo"));
			});
		},
	});
}
