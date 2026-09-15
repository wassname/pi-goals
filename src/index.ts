// Pi/OpenAI: Plan and supervise in the main chat; delegate implementation to a visible worker.
import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, SessionManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { INTERCOM_EXTENSION_REGISTER_EVENT, type IntercomExtensionChannel, type IntercomExtensionRegistration } from "pi-intercom/extension-api.js";
import { openProjectPane } from "pi-subagents/project-panes";
import { Type } from "typebox";
import { noticeDisplay } from "./notice-display.js";
import { FOLD_LINE, foldPlan, GOAL_LINE, planRequirements as requirements } from "./plan.js";
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
	pendingReportReviews,
	planChangedReview,
	planContext,
	planDocument,
	planning,
	planningSeed,
	planUnavailable,
	readyApproved,
	removeGoalSchedule,
	reportReviewContent,
	reportReviewDescription,
	resumeNotice,
	scheduleCheckIn,
	schedulerMessages,
	soloNotice,
	soloRole,
	supervisor,
	upkeep,
	workerAssignment,
	workerAttachment,
	workerReview,
} from "./prompts.js";

const STATE = "pi-goals-main-supervisor-v1";
const WORKER = "goals-worker";
const REPORT = "pi-goals-report", REVIEW = "pi-goals-report-review", REVIEW_DRAFT = "pi-goals-review-draft", REVIEW_REMINDER = "pi-goals-review-reminder";
interface Report { id: string; plan: string; session: string; sessionFile: string; requestId: string; text: string; }
interface ReportReview { id: string; report: string; verdict: string; content: string; continuation: string; }
const WIDGET_GOAL_LIMIT = 3;
type Mode = "chat" | "planning" | "supervising" | "paused" | "solo";
type GoalStatus = "open" | "active" | "reported" | "done" | "cancelled";
interface Peer {
	sessionId: string; sessionFile: string; paneId: string; model?: string;
}
interface State {
	mode: Mode;
	plan?: string;
	worker?: { sessionFile?: string; intercomId?: string; paneId?: string; requestId?: string; parentId?: string; identity?: Peer };
	parent?: { intercomId: string; requestId: string };
	workerStopped?: boolean;
	pausedFrom?: "solo" | "supervising";
	finalReview?: { planDigest: string };
	child?: boolean;
	pausedCheckIns?: Record<string, string>;
}
interface CheckInTask { id: string; name?: string; action?: string; type?: string; scope?: string; sessionFile?: string; prompt?: string; disabledAt?: string; }
const SCHEDULER_SOURCE = fileURLToPath(import.meta.resolve("@jl1990/pi-scheduler/extensions/scheduler/index.ts"));
const initial = (): State => ({ mode: "chat" });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (text: string) => text.trim().toLowerCase();
// Read foreign history without SessionManager.open's on-disk legacy migration.
const savedSession = (path: string) => SessionManager.inMemory(undefined, undefined, readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)));
function goals(text: string) {
	return foldPlan(text).split("\n").flatMap((line, index) => {
		const match = GOAL_LINE.exec(line);
		if (!match) return [];
		const box = match[1].toLowerCase();
		return [{ subject: match[2].trim(), status: (box === "✓" ? "done" : box === "x" ? "reported" : box === "/" ? "active" : box === "-" ? "cancelled" : "open") as GoalStatus, index }];
	});
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
	let liveContext: ExtensionContext | undefined;
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
	const unfinishedGoals = (text: string) => {
		const lines = foldPlan(text).split("\n");
		return goals(text).filter(g => g.status !== "done" && g.status !== "cancelled").map(g => lines[g.index]).join("\n");
	};
	const checkIn = (ctx: ExtensionContext) => scheduleCheckIn(ctx.sessionManager.getSessionId(), state.plan ?? "", ctx.sessionManager.getSessionFile() ?? "", state.pausedCheckIns);
	const hasScheduleTool = () => pi.getAllTools().some((tool) => tool.name === "schedule_task");
	const ownsCheckIn = (task: CheckInTask, ctx: ExtensionContext) => task.name === `goals-${ctx.sessionManager.getSessionId()}` && task.action === "prompt" && task.scope === "session" && Boolean(task.sessionFile) && task.sessionFile === ctx.sessionManager.getSessionFile();
	let agentRunActive = false;
	let clearCheckIn: { generation: number; sessionFile: string; watcher?: FSWatcher; deadline?: ReturnType<typeof setTimeout>; startDeadline?: () => void } | undefined;
	function cancelCheckInRemoval() {
		clearCheckIn?.watcher?.close(); clearTimeout(clearCheckIn?.deadline); clearCheckIn = undefined;
	}
	let pauseCheckIn = false;
	function ownedCheckInIds(ctx: ExtensionContext) {
		const ids = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			const details = entry.type === "custom_message" && entry.customType === "scheduled-task" ? entry.details
				: entry.type === "message" && entry.message.role === "toolResult" && ["schedule_task", "list_scheduled_tasks", "manage_scheduled_task"].includes(entry.message.toolName) ? entry.message.details : undefined;
			const data = details as { task?: CheckInTask; tasks?: CheckInTask[] } | undefined;
			for (const task of data?.task ? [data.task] : data?.tasks ?? []) if (ownsCheckIn(task, ctx)) ids.add(task.id);
		}
		return ids;
	}
	const schedulerCommand = (name: string) => pi.getCommands().find(command => command.source === "extension" && command.sourceInfo?.path === SCHEDULER_SOURCE && (command.name === name || command.name.startsWith(name + ":")))?.name;
	function requestCheckInRemoval(ctx: ExtensionContext) {
		cancelCheckInRemoval();
		const list = schedulerCommand("schedules"), remove = schedulerCommand("schedule-remove");
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!list || !remove || !sessionFile) { ctx.ui.notify(schedulerMessages.unavailable, "warning"); return false; }
		const cursor = ctx.sessionManager.getLeafId();
		const pending: NonNullable<typeof clearCheckIn> = { generation, sessionFile };
		clearCheckIn = pending;
		const unconfirmed = () => { if (clearCheckIn === pending) { cancelCheckInRemoval(); ctx.ui.notify(schedulerMessages.unconfirmed, "warning"); } };
		try {
			// Passive custom messages are persisted without message_end. Observe only the notification;
			// public getBranch() supplies results, never the session file's bytes.
			pending.watcher = watch(sessionFile, { persistent: false }, (event) => {
				if (clearCheckIn !== pending) return;
				if (event === "rename" || pending.generation !== generation || sessionFile !== ctx.sessionManager.getSessionFile()) { unconfirmed(); return; }
				const branch = ctx.sessionManager.getBranch(), index = cursor === null ? -1 : branch.findIndex(entry => entry.id === cursor);
				if (cursor !== null && index < 0) { unconfirmed(); return; }
				for (const entry of branch.slice(index + 1)) if (entry.type === "custom_message") acceptScheduleList({ role: "custom", customType: entry.customType, details: entry.details }, ctx);
			});
			pending.watcher.on("error", unconfirmed);
			pending.startDeadline = () => {
				if (clearCheckIn !== pending || pending.deadline || agentRunActive) return;
				if (pending.generation !== generation || sessionFile !== ctx.sessionManager.getSessionFile()) { unconfirmed(); return; }
				pending.deadline = setTimeout(unconfirmed, 5_000); pending.deadline.unref();
			};
			// A passive result may wait for the busy turn's safe flush; do not expire it beforehand.
			if (!agentRunActive) pending.startDeadline();
		} catch { unconfirmed(); return false; }
		pi.sendUserMessage(`/${list} all`, { expandPromptTemplates: true, deliverAs: "followUp" });
		return true;
	}
	function acceptScheduleList(message: { role: string; customType?: string; details?: unknown }, ctx: ExtensionContext) {
		if (message.role !== "custom" || message.customType !== "scheduled-task" || !clearCheckIn) return;
		const details = message.details as { includeAll?: boolean; tasks?: CheckInTask[] } | undefined;
		if (!details?.includeAll || !Array.isArray(details.tasks)) return;
		const pending = clearCheckIn; cancelCheckInRemoval();
		if (pending.generation !== generation || pending.sessionFile !== ctx.sessionManager.getSessionFile()) return;
		const remove = schedulerCommand("schedule-remove");
		if (!remove) { ctx.ui.notify(schedulerMessages.unavailable, "warning"); return; }
		const matching = details.tasks.filter(task => task.name === `goals-${ctx.sessionManager.getSessionId()}`);
		if (matching.some(task => !ownsCheckIn(task, ctx))) ctx.ui.notify(schedulerMessages.foreign, "warning");
		for (const task of matching.filter(task => ownsCheckIn(task, ctx))) {
			if (!/^[a-zA-Z0-9_-]+$/.test(task.id) || details.tasks.some(other => other !== task && other.id.startsWith(task.id))) { ctx.ui.notify(schedulerMessages.invalid, "warning"); continue; }
			pi.sendUserMessage(`/${remove} ${task.id}`, { expandPromptTemplates: true, deliverAs: "followUp" });
		}
	}
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
		const accepted = items.filter((g) => g.status === "done").length;
		ctx.ui.setStatus("goals", `👀 ${accepted}/${items.length} goals`);
		const mark = (status: GoalStatus) => status === "done" ? "✓" : status === "reported" ? "x" : status === "active" ? "◼" : status === "cancelled" ? "✗" : "◻";
		const priority: Record<GoalStatus, number> = { active: 0, reported: 1, open: 2, done: 3, cancelled: 4 };
		const sorted = [...items].sort((a, b) => priority[a.status] - priority[b.status]);
		const visible = sorted.slice(0, WIDGET_GOAL_LIMIT);
		const lines = visible.map((g) => `${mark(g.status)} G${items.indexOf(g) + 1}: ${g.subject}`);
		const hidden = sorted.slice(WIDGET_GOAL_LIMIT);
		let summary = "";
		if (hidden.length) {
			const counts = (["done", "reported", "active", "open", "cancelled"] as const).map(status => {
				const count = hidden.filter(g => g.status === status).length;
				return count ? `${count} ${mark(status)}` : "";
			}).filter(Boolean);
			summary = `… ${counts.join(", ")}; `;
		}
		const planPath = relative(ctx.cwd, state.plan!);
		const external = isAbsolute(planPath) || planPath === ".." || planPath.startsWith(`..${sep}`);
		lines.push(summary + (external ? `${basename(state.plan!)} (external)` : planPath));
		if (ctx.mode === "tui") ctx.ui.setWidget("goals", () => ({
			render: (width: number) => lines.map((line, index) => truncateToWidth(` ${line}`, width, external && index === lines.length - 1 ? "… (external)" : "…")),
			invalidate() {},
		}));
		else ctx.ui.setWidget("goals", lines);
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
		// plan-change reviews, not another scheduled loop (the hourly job is pi-scheduler's). A
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
		cancelCheckInRemoval(); agentRunActive = false;
		notices.restore(ctx);
		generation++;
		state = initial();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE) state = structuredClone(entry.data as State);
		}
		delete (state as State & { signoffs?: unknown }).signoffs; // Retire old session metadata; never certify [x].
		notice = true;
		turnsStale = 0;
		lastWorkingSet = "";
		pendingUpkeep = undefined;
		finalReviewTurnDigest = undefined;
		fullPlanContextDue = true;
		refresh(ctx);
		watchPlan(ctx);
	}
	function sendAttachment(plan: string, session: string, text: string) {
		pi.sendMessage({ customType: "pi-goals-supervision", content: workerAttachment(plan, session, text), display: true }, { triggerTurn: false });
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
		if (opening) { ctx.ui.notify("A worker launch/resume is still pending; inspect its result before takeover.", "warning"); return false; }
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
	const help = "/goals new [initial idea] | edit | discuss | review | ready | status | stop | resume | solo | attach <plan.md> [solo] | model <model> | quit (exit/clear)\nOpenGoalWorker opens a native project pane; use Intercom to steer the verified worker session. Stop pauses work. Quit/exit/clear preserves the plan and clears goal state without a model call; worker processes are unchanged. No forced compaction or model switch; the worker pane's own model is chosen with /model in that pane. Hourly check-ins are one session-bound schedule_task check-in; plan-change reviews are the plan-watcher event hook.";
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
		return { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? "",
			paneId: process.env.HERDR_PANE_ID ?? "", model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : undefined };
	}
	const records = <T,>(ctx: ExtensionContext, type: string): T[] => ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === type ? [entry.data as T] : []);
	const pendingReports = (ctx: ExtensionContext) => records<Report>(ctx, REPORT).filter(report => report.plan === state.plan && !records<ReportReview>(ctx, REVIEW).some(review => review.report === report.id));
	function recordReport(ctx: ExtensionContext, report: Report) {
		if (records<Report>(ctx, REPORT).some(saved => saved.id === report.id)) return;
		pi.appendEntry(REPORT, report);
		send(workerReview(report.plan, report.session, `${report.id}\n${report.text}`), false);
		if (ctx.isIdle()) remindReports(ctx);
	}
	function remindReports(ctx: ExtensionContext) {
		if (state.child || state.mode !== "supervising") return;
		const ids = pendingReports(ctx).map(report => report.id);
		const fingerprint = digest(JSON.stringify(ids));
		if (!ids.length || records<string>(ctx, REVIEW_REMINDER).at(-1) === fingerprint) return;
		pi.appendEntry(REVIEW_REMINDER, fingerprint);
		send(pendingReportReviews(ids));
	}
	pi.registerEntryRenderer(REVIEW, entry => new Text((entry.data as ReportReview).content, 0, 0));
	function registerChannel(ctx: ExtensionContext) {
		liveContext = ctx;
		const registration: IntercomExtensionRegistration = {
			namespace: "pi-goals", ownerEligible: false,
			onReady: value => { channel = value; },
			onEvent: event => {
				if (event.type === "session_left" && event.sessionId === state.worker?.intercomId && state.plan) {
					let entryId = "disconnected";
					try { entryId = savedSession(state.worker.sessionFile!).getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant").at(-1)?.id || entryId; } catch { /* Unknown history remains a review obligation, not proof of exit. */ }
					recordReport(ctx, { id: `${event.sessionId}:${entryId}`, plan: state.plan, session: event.sessionId, sessionFile: state.worker.sessionFile || "", requestId: state.worker.requestId!, text: nativeMessages.disconnected });
				}
				if (event.type !== "message" || !event.payload || typeof event.payload !== "object") return;
				const data = event.payload as { type?: string; to?: string; requestId?: string; plan?: string; sessionFile?: string; text?: string; identity?: Peer; entryId?: string; review?: ReportReview };
				if (data.type === "review" && state.child && state.parent && event.fromSessionId === state.parent.intercomId && data.requestId === state.parent.requestId && data.plan === state.plan && data.sessionFile === ctx.sessionManager.getSessionFile() && data.review) {
					const prior = records<ReportReview>(ctx, REVIEW).find(saved => saved.report === data.review!.report);
					const review = prior || data.review;
					if (!prior && review.verdict === "changes_requested" && (state.mode === "paused" || !review.continuation.trim())) return;
					if (!prior) {
						pi.appendEntry(REVIEW, review);
						if (review.verdict === "changes_requested") pi.sendUserMessage(review.content, { deliverAs: "followUp" });
					}
					channel?.publish({ ...data, review, type: "review_saved", to: state.parent.intercomId }, { audience: "capable" });
					return;
				}
				if (data.type === "review_saved" && !state.child && data.review) {
					const draft = records<ReportReview>(ctx, REVIEW_DRAFT).find(review => review.id === data.review!.id);
					const report = records<Report>(ctx, REPORT).find(report => report.id === draft?.report);
					if (!draft || !report || event.fromSessionId !== report.session || data.requestId !== report.requestId || data.to !== state.worker?.parentId || data.plan !== report.plan) return;
					try {
						const saved = savedSession(report.sessionFile).getBranch().some(entry => entry.type === "custom" && entry.customType === REVIEW && JSON.stringify(entry.data) === JSON.stringify(draft));
						if (saved && !records<ReportReview>(ctx, REVIEW).some(review => review.id === draft.id)) pi.appendEntry(REVIEW, draft);
					} catch { ctx.ui.notify("Worker review delivery remains unverified; inspect its saved session and retry review_subagent.", "warning"); }
					return;
				}
				const worker = state.worker;
				if (state.child || !worker || !state.plan || !worker.parentId || !data.requestId || data.to !== worker.parentId || event.fromSessionId === data.to || data.requestId !== worker.requestId || data.plan !== state.plan) return;
				if (data.type === "attached" && typeof data.sessionFile === "string" && isAbsolute(data.sessionFile) && (!worker.intercomId || worker.intercomId === event.fromSessionId)) {
					worker.intercomId = event.fromSessionId; worker.sessionFile = data.sessionFile;
					if (data.identity) worker.identity = data.identity;
					workerRevision++; save();
					sendAttachment(state.plan, event.fromSessionId, nativeMessages.attached(data.sessionFile));
				}
				if (data.type === "stopped" && event.fromSessionId === worker.intercomId && typeof data.text === "string") {
					if (data.identity) { worker.identity = data.identity; worker.sessionFile = data.identity.sessionFile; save(); }
					const report: Report = { id: `${event.fromSessionId}:${data.entryId || digest(data.text)}`, plan: state.plan, session: event.fromSessionId, sessionFile: worker.sessionFile!, requestId: data.requestId, text: data.text };
					recordReport(ctx, report);
				}
			},
		};
		pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, registration);
	}
	const reportStop = (text: string) => {
		if (!state.child || !state.parent) return;
		try {
			if (!channel?.snapshot().connected) throw new Error("disconnected");
			channel.publish({ type: "stopped", to: state.parent.intercomId, requestId: state.parent.requestId, plan: state.plan, text: Buffer.from(text).subarray(0, 6000).toString("utf8"), entryId: liveContext?.sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant").at(-1)?.id, identity: liveContext ? identity(liveContext) : undefined }, { audience: "capable" });
		} catch { send(nativeMessages.reportUnavailable, false); }
	};
	pi.on("session_start", (_e, ctx) => {
		restore(ctx); registerChannel(ctx);
	});
	pi.on("session_tree", (_e, ctx) => restore(ctx));
	pi.on("session_shutdown", () => { reportStop(nativeMessages.shuttingDown); cancelCheckInRemoval(); agentRunActive = false; pauseCheckIn = false; channel = undefined; liveContext = undefined; generation++; finalReviewTurnDigest = undefined; planWatcher?.close(); planWatcher = undefined; clearTimeout(planEditTimer); planEditTimer = undefined; });
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
	pi.on("agent_start", () => {
		agentRunActive = true;
		if (clearCheckIn) { clearTimeout(clearCheckIn.deadline); clearCheckIn.deadline = undefined; }
	});
	pi.on("agent_settled", async (_e, ctx) => {
		agentRunActive = false;
		clearCheckIn?.startDeadline?.();
		remindReports(ctx);
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
		const pending = !state.child && state.mode === "supervising" ? pendingReports(ctx) : [];
		return { systemPrompt: `${event.systemPrompt}\n\n${role}${pending.length ? `\n${pendingReportReviews(pending.map(report => `${report.id} (${report.sessionFile})`))}` : ""}`, ...(message ? { message } : {}) };
	});
	pi.on("input", (event, ctx) => {
		if (event.source !== "extension") { pauseCheckIn = false; return; }
		const wake = /^\[Scheduled task ([a-zA-Z0-9_-]+) fired\]\nName: ([^\n]+)\nAction: prompt\n/.exec(event.text);
		if (!wake || wake[2] !== `goals-${ctx.sessionManager.getSessionId()}` || !ownedCheckInIds(ctx).has(wake[1])) return;
		const snapshot = readPlan();
		if (state.mode !== "supervising" || snapshot.text !== undefined && !unfinishedGoals(snapshot.text)) return { action: "handled" as const };
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "manage_scheduled_task" || event.isError) return;
		const task = (event.details as { task?: CheckInTask } | undefined)?.task;
		if (!task || !ownsCheckIn(task, ctx)) return;
		if (pauseCheckIn && state.mode === "paused" && event.input.action === "disable" && task.disabledAt) {
			state.pausedCheckIns = { ...state.pausedCheckIns, [task.id]: task.disabledAt }; pauseCheckIn = false; save();
		} else if (["enable", "remove"].includes(String(event.input.action)) && state.pausedCheckIns?.[task.id]) {
			delete state.pausedCheckIns[task.id]; save();
		}
	});
	pi.on("tool_call", (event, ctx) => {
		if (["schedule_task", "manage_scheduled_task"].includes(event.toolName)) {
			const input = event.input as Record<string, unknown>;
			const ids = ownedCheckInIds(ctx);
			const ownedPrefix = typeof input.id === "string" && [...ids].some(id => id.startsWith(input.id as string));
			if (ownedPrefix && !ids.has(input.id as string)) return { block: true, reason: schedulerMessages.invalid };
			const owned = input.name === `goals-${ctx.sessionManager.getSessionId()}` || typeof input.id === "string" && ids.has(input.id);
			if (event.toolName === "schedule_task" && owned && (state.child || state.mode !== "supervising" || !unfinishedGoals(planText()) || input.action !== "prompt" || input.type !== "interval" || input.scope !== "session")) return { block: true, reason: schedulerMessages.creation };
			if (owned && typeof input.prompt === "string" && input.prompt !== input.prompt.trim().replace(/\s+/g, " ")) return { block: true, reason: schedulerMessages.format };
		}
		if (event.toolName !== "subagent" && event.toolName !== "OpenGoalWorker") return;
		if (state.child || ["planning", "paused", "solo"].includes(state.mode)) return { block: true, reason: goalToolBlocked(state.child ? "worker" : state.mode) };
	});

	pi.registerCommand("goals", {
		description: "Goal plan actions: new, edit, discuss, review, ready, status, stop, resume, solo, attach, model, quit (exit/clear)",
		getArgumentCompletions: (prefix) => ["new", "attach", "edit", "discuss", "review", "ready", "status", "stop", "resume", "solo", "model", "help", "exit", "clear", "quit"].filter((verb) => verb.startsWith(prefix)).map((verb) => ({ value: verb, label: verb })),
		handler: async (args, ctx) => {
			try {
				if (state.child) {
					if (["stop", "resume"].includes(args.trim())) { cancelCheckInRemoval(); state.mode = args.trim() === "stop" ? "paused" : "solo"; generation++; save(); ctx.ui.notify(nativeMessages.workerPause(state.mode === "paused"), "info"); return; }
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
						`Preferred worker model (plan, not configuration): ${notedPlanValue("preferred worker model") ?? "inherit"}`,
						`Last observed worker model: ${state.worker?.identity?.model ?? "unconfirmed"}; verify current choice before claiming configuration.`,
						`Pending report reviews: ${pendingReports(ctx).map(report => report.id).join(", ") || "none"}`,
						`Recorded worker session: ${state.worker?.sessionFile ?? "not recorded"}`,
						`Worker Intercom: ${state.worker?.intercomId ?? "unconfirmed"}; native pane: ${state.worker?.paneId ?? "unconfirmed"}`,
						notedPlanValue("worker session") ? `Worker session noted in plan: ${notedPlanValue("worker session")}` : "",
						`Check-in: session-scoped pi-scheduler task ${JSON.stringify(`goals-${ctx.sessionManager.getSessionId()}`)} (default 1h; /schedules all shows current recurrence; manage_scheduled_task updates it)`,
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
					const pref = `- preferred worker model: ${ref}`;
					const found = lines.findIndex((line) => /^-\s*preferred worker model:/i.test(line));
					if (found >= 0) lines[found] = pref;
					else { const title = lines.findIndex((line) => /^#\s/.test(line)); lines.splice(title >= 0 ? title + 1 : 0, 0, pref); }
					writeFileSync(state.plan, lines.join("\n"));
					planHash = digest(planViews(planText()).notify);
					refresh(ctx);
					notice = true; fullPlanContextDue = true;
					ctx.ui.notify(`Preferred worker model recorded as ${ref}; not yet configured. Pass it to the agent in its assignment or live steering for configuration through supported controls, then verify its actual model.`, "info");
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
					const worker = noted ? { sessionFile: resolve(ctx.cwd, noted) } : state.workerStopped ? state.worker : undefined;
					state = { mode: solo ? "solo" : "planning", plan: target, worker, workerStopped: solo || (!noted && state.workerStopped) };
					generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx); watchPlan(ctx);
					if (solo) enterSolo(ctx);
					else send(attachNotice(target, false, noted));
					return;
				}
				if (command === "exit") {
					cancelCheckInRemoval();
					state = initial(); generation++; workerRevision++; pendingUpkeep = undefined; notice = true;
					save(); refresh(ctx); watchPlan(ctx);
					const queued = requestCheckInRemoval(ctx);
					ctx.ui.notify(queued ? schedulerMessages.queued : schedulerMessages.cleared, queued ? "info" : "warning");
					return;
				}
				if (command === "stop") {
					if (state.mode === "planning") { ctx.ui.notify("A draft cannot pause; use /goals quit to clear goal state and preserve the draft.", "warning"); return; }
					if (state.mode !== "solo" && state.mode !== "supervising") return;
					cancelCheckInRemoval();
					state.pausedFrom = state.mode;
					state.mode = "paused"; generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx); watchPlan(ctx);
					pauseCheckIn = true;
					const pause = pauseExitNotice(state.worker, false);
					const requestCleanup = Boolean(state.worker) || hasScheduleTool();
					if (!requestCleanup) ctx.ui.notify(pause, "info"); // Visible now; passive model context waits for a prompt.
					send(`${removeGoalSchedule(ctx.sessionManager.getSessionId(), true)}\n\n${pause}`, requestCleanup);
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
				state = { mode: "planning", plan: path, worker: state.worker, workerStopped: state.workerStopped }; generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx); watchPlan(ctx);
				send(planningSeed(objective, path));
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});
	pi.registerTool({
		name: "OpenGoalWorker", label: "Open native goal worker", description: nativeMessages.openDescription,
		parameters: Type.Object({ task: Type.String({ minLength: 1 }), model: Type.Optional(Type.String({ description: nativeMessages.modelDescription })) }),
		async execute(_id, params, signal, _update, ctx) {
			if (state.child || state.mode !== "supervising" || !state.plan) return result(goalToolBlocked(state.mode));
			if (opening || state.worker) return result(nativeMessages.alreadyRecorded);
			if (!params.task.trim()) return result(nativeMessages.taskRequired);
			const preference = params.model?.trim() || notedPlanValue("preferred worker model");
			const model = preference && (preference.includes("/") || !/^(?:none|\(none|default|inherit|not stated)\b/i.test(preference)) ? preference : undefined;
			if (!channel?.snapshot().connected || !channel.snapshot().supported) return result(nativeMessages.intercomNotReady);
			const stamp = generation, plan = state.plan;
			const peers = await channel.listSessions().catch(() => undefined);
			if (!peers) return result(nativeMessages.intercomNotReady);
			const self = peers.filter(peer => peer.pid === process.pid);
			if (self.length !== 1) return result(nativeMessages.noIdentity);
			if (stamp !== generation || opening || state.worker || signal?.aborted) return result(messages.cancelled);
			const requestId = randomUUID();
			state.worker = { requestId, parentId: self[0].id }; state.workerStopped = false; workerRevision++; opening = true; save();
			try {
				// Stock open sends startup only to a newly created context; existing panes receive nothing.
				const pane = await openProjectPane({ cwd: ctx.cwd, message: workerAssignment(plan, self[0].id, requestId, params.task, model), focus: false, signal });
				if (pane.ok && state.plan === plan && state.worker?.requestId === requestId) { state.worker.paneId = pane.data.binding.paneId; save(); }
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
				state = { ...initial(), child: true, mode: "solo", parent: { intercomId: params.parent!, requestId: params.requestId! } };
			}
			state.plan = params.path; generation++; notice = true; fullPlanContextDue = true; save(); refresh(ctx);
			if (state.parent) channel?.publish({ type: "attached", to: state.parent.intercomId, requestId: state.parent.requestId, plan: state.plan, sessionFile: ctx.sessionManager.getSessionFile(), identity: identity(ctx) }, { audience: "capable" });
			return result(childPlanAttached(params.path));
		},
	});
	const sourceQuote = Type.Object({ path: Type.String({ minLength: 1 }), entryId: Type.Optional(Type.String()), quote: Type.String({ minLength: 1 }) });
	pi.registerTool({
		name: "review_subagent", label: "Review worker report", description: reportReviewDescription,
		parameters: Type.Object({
			report: Type.String({ minLength: 1 }), goal: sourceQuote,
			evidence: Type.Array(Type.Object({ path: Type.String({ minLength: 1 }), entryId: Type.Optional(Type.String()), quote: Type.Optional(Type.String()), observation: Type.String({ minLength: 1 }) }), { minItems: 1 }),
			observation: Type.String({ minLength: 1 }), unmet: Type.String({ minLength: 1 }),
			verdict: Type.String({ enum: ["accepted", "changes_requested", "blocked"] }), continuation: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (state.child || state.mode !== "supervising") throw new Error("Only the active parent supervisor can review worker reports.");
			const report = records<Report>(ctx, REPORT).find(report => report.id === params.report && report.plan === state.plan);
			if (!report) throw new Error("Unknown owned report; inspect pending report reviews in /goals status.");
			if (!["accepted", "changes_requested", "blocked"].includes(params.verdict) || !params.goal.quote.trim() || !params.observation.trim() || !params.unmet.trim() || params.verdict === "changes_requested" && !params.continuation?.trim()) throw new Error("Supply the verdict, inspection, unmet requirements (or none), and a concrete continuation for changes_requested.");
			const sources = [params.goal, ...params.evidence].map(source => {
				const path = resolve(ctx.cwd, source.path), bytes = readFileSync(path);
				if (!bytes.length) throw new Error(`Empty evidence: ${path}`);
				let text = bytes.toString("utf8");
				if (source.entryId) {
					const entry = savedSession(path).getBranch().find(entry => entry.id === source.entryId);
					if (!entry) throw new Error(`Missing session entry: ${path}#${source.entryId}`);
					const content = entry.type === "message" && "content" in entry.message ? entry.message.content : entry.type === "custom_message" ? entry.content : undefined;
					text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : JSON.stringify(entry);
				}
				const binary = bytes.includes(0) || /\.(png|jpe?g|gif|webp|pdf|mp4)$/i.test(path);
				if (!source.quote?.trim() && !binary || source.quote && !text.includes(source.quote)) throw new Error(`Quote does not match source: ${path}`);
				if ("observation" in source && !source.observation.trim()) throw new Error(`Describe the inspected evidence: ${path}`);
				return `${path}${source.entryId ? `#${source.entryId}` : ""}\n${source.quote ? `> ${source.quote}` : "[non-text capture]"}${"observation" in source ? `\nObserved: ${source.observation}` : ""}`;
			});
			const content = reportReviewContent(report.id, report.sessionFile, sources, params.observation, params.unmet, params.verdict, params.continuation || "");
			const review: ReportReview = { id: digest(content), report: report.id, verdict: params.verdict, content, continuation: params.continuation || "" };
			if (records<ReportReview>(ctx, REVIEW).some(saved => saved.report === report.id)) return result("This report already has a delivered review; a new revision needs its own report.");
			if (!channel?.snapshot().connected || !channel.snapshot().supported || signal?.aborted) throw new Error("Review delivery unavailable; report remains pending.");
			const payload = { type: "review", to: report.session, sessionFile: report.sessionFile, requestId: report.requestId, plan: report.plan, review };
			if (Buffer.byteLength(JSON.stringify(payload)) > 16000) throw new Error("Review exceeds Intercom's 16 KiB limit; shorten the quotes and retain source references.");
			if (!records<ReportReview>(ctx, REVIEW_DRAFT).some(saved => saved.id === review.id)) pi.appendEntry(REVIEW_DRAFT, review);
			channel.publish(payload, { audience: "capable" });
			return result("Review sent for saving in the worker conversation. Obligation remains pending until the exact saved review is verified; use /goals status to inspect delivery.");
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
				const othersAccepted = goals(text).every((goal) => goal.status === "cancelled" || key(goal.subject) === subject || goal.status === "done");
				if (othersAccepted && matches[0].status !== "done") {
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
				lines[matches[0].index] = lines[matches[0].index].replace(/\[[ xX/✓-]\]/, "[✓]");
				let log = lines.findIndex(line => FOLD_LINE.test(line));
				if (log === -1) { lines.push("", "## Log"); log = lines.length - 1; }
				lines.splice(log + 1, 0, "", completionLog(params.goal, params.observation, evidence, state.mode === "solo"));
				writeFileSync(path, `${lines.join("\n").trimEnd()}\n`);
				state.finalReview = undefined;
				finalReviewTurnDigest = undefined;
				planHash = digest(planViews(planText()).notify);
				save(); refresh(ctx);
				const remaining = Boolean(unfinishedGoals(planText()));
				if (!remaining) requestCheckInRemoval(ctx);
				return result(completionResult(matches[0].subject, ctx.sessionManager.getSessionId(), remaining, state.mode === "solo"));
			});
		},
	});
}
