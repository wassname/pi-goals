// PI/OpenAI: one agent, one goal page, human Ready, a stock scheduled loop, and a fresh judge at a stop and at completion.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { liveDescendants } from "./children.js";
import type { UserMessage } from "./goals.js";
import { appendEvidence, BEFORE_LINES, dialogue, keepPage, lastLines, lineCount, NOTE_LINES, NOTES, PAGE_LINES, section, split, stamp, widgetLines } from "./goals.js";
import { decideSignOff, runJudge, signOffTask, stopVerdict } from "./judge.js";
import { loopTaskId, schedulerCommand, startLoop, stopLoop, wakeSchedule, wakeToken } from "./loop.js";
import * as prompts from "./prompts.js";

const STATE = "pi-goals-single-agent";
/** The user's own messages, kept in the session so the newest survive compaction. */
const USER_MESSAGE = "pi-goals-user-message";
const RECENT_MESSAGES = 5;
const MESSAGE_CHARS = 4000;
const LAST_REPLY_CHARS = 8000;
const STOP_JUDGE_MS = 180_000;
/** Continuations after one wake from outside (the user, a reminder, a job notice): a mistaken reviewer cannot spin. */
const MAX_CONTINUES = 10;
interface State {
	owner: string;
	phase: "planning" | "working" | "paused" | null;
	retired?: { token: string; source?: string }[];
	reminderSource?: string;
	reminderWarning?: boolean;
	file?: string;
	/** Identifies this Ready's scheduled wakes; older or foreign wakes are dropped. */
	token?: string;
	judge: boolean;
	model?: string;
	/** The goal is finished: accepted by the sign-off judge, or self-verified with the judge off. */
	done?: "accepted" | "self-verified";
}
// wassname 2026-11-07: pi-subagents ends each successful completion notice with this text, which asks the
// agent to report and forbids a quiet stop; while goals run it pulls the agent into reporting. Matched exactly
// (test/real-parsers.test.ts checks it against the installed pi-subagents); failed or stopped runs keep their text.
export const SUBAGENT_COMPLETION_ACTION = "Read the saved results above and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
type Messages = ContextEvent["messages"];
/** The same array when nothing changed, so unchanged history keeps its prompt cache. */
function quietSubagentNotices(messages: Messages): Messages {
	let changed = false;
	const out = messages.map((message) => {
		if (message.role !== "custom" || typeof message.content !== "string" || !message.content.includes(SUBAGENT_COMPLETION_ACTION)) return message;
		// Failed, stopped or paused runs keep the push; the silent-wake reminder carries no runs and points at the notices.
		const details = message.details as { runs?: { status?: string }[]; outcome?: string } | undefined;
		const completed = message.customType === "subagent-notify" ? Boolean(details?.runs?.length && details.runs.every((run) => run.status === "completed"))
			: message.customType === "subagent-incremental-child-notify" ? details?.outcome === "completed"
			: message.customType === "subagent-completion-unanswered";
		if (!completed) return message;
		changed = true;
		return { ...message, content: message.content.replaceAll(`\n\nParent action: ${SUBAGENT_COMPLETION_ACTION}`, "").replaceAll(` ${SUBAGENT_COMPLETION_ACTION}`, "") };
	});
	return changed ? out : messages;
}

const initial = (owner: string): State => ({ owner, phase: null, judge: true });
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const handled = { action: "handled" as const };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const clip = (text: string, chars: number) => text.length > chars ? `${text.slice(0, chars / 2)}\n… (middle cut; the session transcript has it) …\n${text.slice(-chars / 2)}` : text;

/** Text of the last assistant message: what the agent said as it stopped. */
function lastReply(messages: { role: string; content: unknown }[]): string {
	const content = [...messages].reverse().find((message) => message.role === "assistant")?.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part) => part?.type === "text" ? [String(part.text)] : []).join("\n") : "";
	return clip(text.trim(), LAST_REPLY_CHARS);
}

export default function piGoals(pi: ExtensionAPI): void {
	let state = initial("");
	let generation = 0;
	let reviewRequested = false;
	let resyncDue = false;
	let reviewing = false;
	let judging = false;
	let kickoff: string | undefined;
	/** The page as last seen. A change that the agent's edit tools did not make is taken as the user's. */
	let page = "";
	/** Since the last wake from outside: continuations sent, and tool calls in the run that is ending. */
	let continues = 0;
	let toolCalls = 0;
	let stopReview: AbortController | undefined;
	const persist = () => pi.appendEntry(STATE, { ...state });
	const read = () => readFileSync(state.file!, "utf8");
	const save = (text: string) => writeFileSync(state.file!, text);
	const judgeModel = (ctx: ExtensionContext) => state.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	const said = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === USER_MESSAGE ? [entry.data as UserMessage] : []);
	/** For the worker after compaction: its newest exchanges with the user. For a judge: the whole history, within its line budget. */
	const recent = (ctx: ExtensionContext) => dialogue(said(ctx).slice(-RECENT_MESSAGES));
	const history = (ctx: ExtensionContext) => dialogue(said(ctx));
	/** Keep what the user typed, with the end of the agent message they were answering. */
	function keepMessage(ctx: ExtensionContext, text: string) {
		const replies = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);
		const before = lastLines(lastReply(replies.slice(-1)), BEFORE_LINES);
		pi.appendEntry(USER_MESSAGE, { at: stamp(), text: clip(text, MESSAGE_CHARS), ...(before ? { before } : {}) } satisfies UserMessage);
	}
	function pageMoved(): boolean {
		const now = split(read()).page;
		if (now === page) return false;
		page = now;
		return true;
	}
	function requirePage(text: string) {
		if (!section(text, "Goal") || !section(text, "Loop statement") || section(text, NOTES) === undefined) throw new Error(prompts.pageIncomplete);
	}

	// A click on the widget flips it; so does Pi's ctrl+o (app.tools.expand), read at each render.
	let clicked = false;

	function refresh(ctx: ExtensionContext) {
		if (!state.file) {
			ctx.ui.setStatus("goals", undefined);
			ctx.ui.setWidget("goals", undefined);
			return;
		}
		try {
			const text = read();
			const status = state.done ?? state.phase ?? "";
			const scheduler = state.phase === "working" && state.reminderWarning ? " · scheduler: unconfirmed" : "";
			ctx.ui.setStatus("goals", `${status}${scheduler} · ${relative(ctx.cwd, state.file)}`);
			if (state.phase === "planning") ctx.ui.setWidget("goals", undefined);
			else if (ctx.mode === "tui") {
				let cached: { width: number; expanded: boolean; lines: string[] } | undefined;
				ctx.ui.setWidget("goals", (_tui, theme) => ({
					render: (width) => {
						const expanded = clicked !== ctx.ui.getToolsExpanded();
						if (cached?.width !== width || cached.expanded !== expanded) cached = { width, expanded, lines: widgetLines(text, status, width, { expanded, style: { fg: (color, s) => theme.fg(color, s) } }) };
						return cached.lines;
					},
					handleMouse: (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						clicked = !clicked;
						return { handled: true };
					},
					invalidate() { cached = undefined; },
				}));
			} else ctx.ui.setWidget("goals", widgetLines(text, status));
		} catch (error) { ctx.ui.setWidget("goals", [String(error)]); }
	}

	function cleanRetired(ctx: ExtensionContext) {
		for (const task of state.retired ?? []) {
			const id = loopTaskId(ctx, task.token);
			if (!id) continue;
			try { stopLoop(pi, id, task.source); }
			catch (error) { ctx.ui.notify(prompts.schedulerCleanupFailed(id, errorMessage(error)), "warning"); continue; }
			state = { ...state, retired: state.retired!.filter(t => t.token !== task.token) };
			persist();
		}
	}

	function retireReminder() {
		if (!state.token) return;
		state = { ...state, retired: [...(state.retired ?? []), { token: state.token, source: state.reminderSource }], token: undefined, reminderSource: undefined, reminderWarning: undefined };
	}
	function pause(ctx: ExtensionContext) {
		kickoff = undefined;
		stopReview?.abort();
		retireReminder();
		state = { ...state, phase: "paused" };
		generation++; persist(); refresh(ctx); cleanRetired(ctx);
	}

	const notice = (message: string) => pi.sendMessage({ customType: "goals-startup", content: message, display: true }, { triggerTurn: false });
	function warnReminder(ctx: ExtensionContext, reason: string) {
		if (state.reminderWarning) return;
		state = { ...state, reminderWarning: true }; persist(); refresh(ctx);
		notice(prompts.reminderWarning(reason));
	}
	function checkReminder(ctx: ExtensionContext): boolean {
		if (state.phase !== "working") return false;
		try { schedulerCommand(pi, "schedule", state.reminderSource); }
		catch (error) { warnReminder(ctx, errorMessage(error)); return false; }
		if (!state.token || !loopTaskId(ctx, state.token)) { warnReminder(ctx, prompts.noReminderReceipt); return false; }
		if (state.reminderWarning) {
			state = { ...state, reminderWarning: undefined }; persist(); refresh(ctx);
			notice(prompts.reminderConfirmed);
		}
		return true;
	}
	function scheduleReminder(ctx: ExtensionContext) {
		try {
			const { source } = schedulerCommand(pi, "schedule");
			schedulerCommand(pi, "schedule-remove", source);
			state = { ...state, reminderSource: source }; persist();
			startLoop(pi, ctx, state.token!, source);
		} catch (error) {
			if (state.reminderWarning) notice(prompts.reminderWarning(errorMessage(error)));
			else warnReminder(ctx, errorMessage(error));
		}
	}
	function begin(ctx: ExtensionContext, approved = read()) {
		const text = read();
		if (text !== approved) { notice(prompts.changedPlan); return; }
		requirePage(text);
		const token = randomUUID();
		state = { ...state, phase: "working", token, done: undefined };
		page = split(text).page;
		generation++; persist(); refresh(ctx);
		scheduleReminder(ctx);
		kickoff = token;
		pi.sendUserMessage(prompts.startWork(token), { deliverAs: "steer" });
	}

	async function review(ctx: ExtensionContext) {
		if (reviewing || state.phase !== "planning" || !ctx.hasUI) return;
		reviewing = true;
		const current = generation;
		try {
			while (current === generation) {
				const text = read();
				requirePage(text);
				pi.sendMessage({ customType: "goals-draft", content: text, display: true });
				// Discuss (or Escape) closes the menu and keeps planning, so the user can answer in chat.
				const choice = await ctx.ui.select(`Goal: ${relative(ctx.cwd, state.file!)}`, ["Ready", "Discuss in chat", "Edit", "Cancel"]);
				if (current !== generation) return;
				if (choice === "Ready") return begin(ctx, text);
				if (choice === "Edit") {
					const edited = await ctx.ui.editor("Edit goal", text);
					if (current !== generation) return;
					if (edited !== undefined) save(edited);
					continue;
				}
				if (choice === "Cancel") { state = { ...initial(state.owner), retired: state.retired }; generation++; persist(); refresh(ctx); }
				return;
			}
		} finally { reviewing = false; }
	}

	pi.registerCommand("goals", {
		description: "Goals: new [idea], review, replan, pause, resume, retry, clear, judge [off|on|provider/model]",
		handler: async (args, ctx) => {
			try {
				let arg = args.trim();
				cleanRetired(ctx);
				if (!arg) arg = (await ctx.ui.select("Goals", state.file ? ["review", "replan", "pause", "resume", "clear"] : ["new"])) ?? "";
				if (!arg) return;
				if (arg === "clear") {
					if (state.token) pause(ctx);
					state = { ...initial(ctx.sessionManager.getSessionId()), retired: state.retired };
					generation++; resyncDue = false; reviewRequested = false;
					persist(); refresh(ctx); return;
				}
				if (arg === "pause") { if (state.phase === "working") pause(ctx); return; }
				if (arg === "replan") {
					if (state.phase !== "working" && state.phase !== "paused") throw new Error("Replan reopens an approved goal page; use /goals new first.");
					kickoff = undefined;
					stopReview?.abort();
					retireReminder();
					state = { ...state, phase: "planning", done: undefined };
					generation++; persist(); refresh(ctx); cleanRetired(ctx);
					pi.sendUserMessage(prompts.replan(state.file!), { deliverAs: "steer" });
					return;
				}
				if (arg === "resume") { if (state.phase !== "paused") throw new Error("Only a paused or finished goal can resume."); begin(ctx); return; }
				if (arg === "retry") {
					if (state.phase !== "working") throw new Error("Only a working goal can retry reminders.");
					if (kickoff) throw new Error("Retry the scheduler after the Ready prompt is delivered.");
					if (state.token && loopTaskId(ctx, state.token)) {
						if (checkReminder(ctx)) ctx.ui.notify(prompts.reminderConfirmed, "info");
						else ctx.ui.notify(prompts.schedulerUnavailable, "warning");
						return;
					}
					ctx.ui.notify(prompts.reminderRetrying, "info");
					const reminderWarning = state.reminderWarning;
					retireReminder();
					state = { ...state, token: randomUUID(), reminderWarning }; persist();
					scheduleReminder(ctx); return;
				}
				if (arg === "review") {
					if (state.phase !== "planning") ctx.ui.notify(prompts.reviewUnavailable, "info");
					else await review(ctx);
					return;
				}
				if (arg === "judge" || arg.startsWith("judge ")) {
					const value = arg.slice(5).trim();
					state = { ...state, judge: value !== "off", model: ["", "on", "off"].includes(value) ? undefined : value };
					persist(); ctx.ui.notify(`Judge ${state.judge ? state.model ?? "uses the session model" : "disabled: completion is self-verification, and a stop is not reviewed"}.`, "info"); return;
				}
				if (arg !== "new" && !arg.startsWith("new ")) throw new Error("Use /goals new [idea], review, replan, pause, resume, retry, clear, or judge.");
				if (state.file) throw new Error("Clear the current goal before starting a new one; the file is preserved.");
				const idea = arg.slice(3).trim();
				const dir = join(ctx.cwd, ".pi/goals");
				mkdirSync(dir, { recursive: true });
				// Session IDs start with a timestamp; the last 6 characters differ between sessions.
				const suffix = ctx.sessionManager.getSessionId().slice(-6);
				const taken = readdirSync(dir).map(name => Number(new RegExp(`^${suffix}-v(\\d+)\\.md$`).exec(name)?.[1] ?? 0));
				const file = join(dir, `${suffix}-v${Math.max(0, ...taken) + 1}.md`);
				writeFileSync(file, prompts.goalsTemplate, { flag: "wx" });
				page = split(prompts.goalsTemplate).page;
				state = { ...state, owner: ctx.sessionManager.getSessionId(), phase: "planning", file, done: undefined };
				generation++; reviewRequested = false; resyncDue = false;
				persist(); refresh(ctx);
				// Slash commands skip the input hook; keep the user's opening words too.
				if (idea) keepMessage(ctx, `/goals new ${idea}`);
				// Steer: a busy agent must get the planning rules now, not after it has already drafted.
				pi.sendUserMessage(prompts.draft(file, idea), { deliverAs: "steer" });
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});

	pi.registerTool({
		name: "RequestPlanReview", label: "Review goal", description: prompts.requestReview,
		parameters: Type.Object({}),
		async execute() {
			if (state.phase !== "planning") throw new Error("No goal discussion is active.");
			const text = read();
			requirePage(text);
			const lines = lineCount(split(text).page);
			if (lines > PAGE_LINES) throw new Error(prompts.pageTooLong(lines));
			reviewRequested = true;
			return result(prompts.reviewQueued);
		},
	});

	// A review request is for the turn that made it; a later message (answers, queued prompts) cancels it.
	pi.on("message_start", async (event) => {
		if (event.message.role === "user") reviewRequested = false;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		cleanRetired(ctx);
		if (!kickoff) checkReminder(ctx);
		if (!reviewRequested) return;
		reviewRequested = false;
		try { await review(ctx); } catch (error) { ctx.ui.notify(String(error), "error"); }
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			const work = prompts.startWorkToken(event.text);
			if (work) {
				if (work !== kickoff || state.phase !== "working") return handled;
				kickoff = undefined;
				return { action: "transform" as const, text: prompts.readyPrompt(state.file!, read(), recent(ctx)) };
			}
			const token = wakeToken(event.text);
			if (!token) return;
			if (token !== state.token || state.phase !== "working") { cleanRetired(ctx); return handled; }
			continues = 0;
			try { return { action: "transform" as const, text: prompts.loopPrompt(read(), state.file!, wakeSchedule(event.text)) }; }
			catch (error) { notice(prompts.schedulerWakeFailed(errorMessage(error))); return handled; }
		}
		// The user spoke: a stop review in progress gives way to them.
		continues = 0;
		stopReview?.abort();
		if (state.file && event.text.trim()) keepMessage(ctx, event.text);
	});

	// The whole file and the user's newest messages after Ready, compaction, resume or a page the user edited:
	// persisted at the next prompt, or transient once if an auto-compaction retry continues without before_agent_start.
	const resyncText = (ctx: ExtensionContext, edited = false) => state.phase === "planning"
		? prompts.planningResync(read(), state.file!, edited ? prompts.draftEdited : "Session started or compacted.")
		: prompts.resync(read(), state.file!, edited ? prompts.pageEdited : "Session started or compacted.", recent(ctx), state.phase === "paused");
	const watched = () => Boolean(state.file) && (state.phase === "working" || state.phase === "planning");
	pi.on("before_agent_start", async (_event, ctx) => {
		// A prompt from outside (the user, a reminder, a job notice) starts this run.
		continues = 0; toolCalls = 0;
		if (!state.file) return;
		const edited = watched() && pageMoved();
		if (!resyncDue && !edited) return;
		resyncDue = false;
		return { message: { customType: "goals-context", content: resyncText(ctx, edited), display: false } };
	});
	pi.on("context", async (event, ctx) => {
		const messages = state.phase === "working" ? quietSubagentNotices(event.messages) : event.messages;
		if (state.file && resyncDue) {
			resyncDue = false;
			return { messages: [...messages, { role: "user" as const, content: [{ type: "text" as const, text: resyncText(ctx) }], timestamp: Date.now() }] };
		}
		if (messages !== event.messages) return { messages };
	});
	pi.on("session_compact", async () => { resyncDue = true; });
	pi.on("turn_end", async (_event, ctx) => {
		// The user edited the page during the run, or a shell command did.
		if (watched() && pageMoved()) pi.sendMessage({ customType: "goals-context", content: resyncText(ctx, true), display: true }, { deliverAs: "steer", triggerTurn: true });
		refresh(ctx);
	});

	// The page is the user's: an agent edit to it is undone, and its notes are kept. Agents also edit the file from the
	// shell (seen 2026-11-27: nine python edits in one planning turn), so a command that names the file counts as an edit.
	const textBefore = new Map<string, string>();
	const namesGoalsFile = (command: string) => command.includes(basename(state.file!)) || command.includes(".pi/goals/");
	pi.on("tool_call", async (event, ctx) => {
		toolCalls++;
		const path = ["write", "edit"].includes(event.toolName) ? resolve(ctx.cwd, String((event.input as { path?: string }).path)) : undefined;
		const goalsEdit = Boolean(state.file) && path === state.file;
		const shellEdit = Boolean(state.file) && event.toolName === "bash" && namesGoalsFile(String((event.input as { command?: string }).command));
		if (goalsEdit || shellEdit) textBefore.set(event.toolCallId, read());
		// Planning allows exploration; only file edits outside the goals file and slop/ (briefs, notes), and completion, are blocked.
		const slopEdit = path !== undefined && !relative(resolve(ctx.cwd, "slop"), path).startsWith("..");
		if (state.phase !== "planning" || goalsEdit || slopEdit || !["write", "edit", "CompleteGoal"].includes(event.toolName)) return;
		return { block: true, reason: prompts.planningState(state.file!) };
	});
	pi.on("tool_result", async (event) => {
		const before = textBefore.get(event.toolCallId);
		if (before === undefined) return;
		textBefore.delete(event.toolCallId);
		const notes: string[] = [];
		const kept = state.phase === "working" ? keepPage(before, read()) : undefined;
		if (kept !== undefined) { save(kept); notes.push(prompts.pageKept); }
		const text = read();
		page = split(text).page;
		const lines = lineCount(section(text, NOTES) ?? "");
		if (state.phase === "working" && lines > NOTE_LINES) notes.push(prompts.noteTooLong(lines));
		if (notes.length) return { content: [...event.content, ...notes.map((note) => ({ type: "text" as const, text: note }))] };
	});

	// A stop with the goal open. A fresh judge reads the page, the note and the last message; unless a named job will
	// wake the agent or only the user can decide, the agent is sent back with the reviewer's one finding.
	pi.on("agent_before_settle", async (event, ctx) => {
		const ran = toolCalls;
		toolCalls = 0;
		if (state.phase !== "working" || !state.file || kickoff || judging || event.outcome !== "completed" || event.continue) return;
		// A queued message (the user, a reminder, a job notice) runs next: that is a wake from outside.
		if (event.context.pendingMessages?.length) { continues = 0; return; }
		// A reply to a continuation that called no tools is the agent's answer; ask again only after a wake from outside.
		if (continues >= MAX_CONTINUES || (continues > 0 && ran === 0)) return;
		const current = generation;
		// The user's next message, or a pause, cancels the review from here on.
		const abort = new AbortController();
		stopReview = abort;
		ctx.signal?.addEventListener("abort", () => abort.abort(), { once: true });
		const stale = () => abort.signal.aborted || current !== generation;
		try {
			// wassname 2026-11-27: "we used to wait if a subagent or subprocess was running ... and not mind the idles there".
			// Its completion notice wakes the session, and the stop is reviewed then.
			try { if (await liveDescendants()) return; }
			catch (error) { ctx.ui.notify(`pi-goals could not list running subagents (${errorMessage(error)}); reviewing the stop anyway.`, "warning"); }
			if (stale()) return;
			let note = prompts.idle(state.file);
			if (state.judge) {
				ctx.ui.setStatus("goals", "reviewing the stop …");
				const task = prompts.stopTask({ text: read(), path: state.file, last: lastReply(event.context.llmMessages), history: history(ctx) });
				const reviewed = stopVerdict(await runJudge(pi.events, { task, schema: prompts.stopSchema, cwd: ctx.cwd, model: judgeModel(ctx) }, abort.signal, { startMs: 15_000, totalMs: STOP_JUDGE_MS }));
				if (stale()) return;
				if ("error" in reviewed) note = `${prompts.stopJudgeFailed(reviewed.error)} ${note}`;
				else if (reviewed.verdict !== "continue") return { entries: [...event.entries, { type: "custom_message" as const, customType: "goals-stop", content: prompts.stopAccepted(reviewed.verdict, reviewed.reason), display: true }] };
				else note = prompts.stopContinue(reviewed.reason, reviewed.next);
			}
			continues++;
			return { entries: [...event.entries, { type: "custom_message" as const, customType: "goals-stop", content: note, display: true }], continue: true };
		} finally {
			if (stopReview === abort) stopReview = undefined;
			refresh(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		generation++; reviewRequested = false; kickoff = undefined;
		stopReview?.abort();
		const last = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === STATE).at(-1);
		const saved = last?.type === "custom" ? last.data as State & { taskCreateOff?: boolean } : undefined;
		state = saved?.owner === ctx.sessionManager.getSessionId() ? saved : initial(ctx.sessionManager.getSessionId());
		// A fork has a new session ID, so it does not inherit goals; say so once, then record that this session has none.
		if (saved?.file && saved.owner !== state.owner) { ctx.ui.notify(prompts.forkNotice(saved.file), "info"); persist(); }
		// Earlier versions turned TaskCreate off while goals ran, and Pi restores the tool list from the transcript.
		if (saved?.taskCreateOff && saved.owner === state.owner) {
			const active = pi.getActiveTools();
			if (!active.includes("TaskCreate") && pi.getAllTools().some((tool) => tool.name === "TaskCreate")) pi.setActiveTools([...active, "TaskCreate"]);
			state = { ...state, taskCreateOff: undefined } as State; persist();
		}
		try {
			// A file from before the one-page format (several goals, tasks, a log) cannot be worked: detach it, unchanged.
			if (state.file && state.phase !== "planning" && section(read(), NOTES) === undefined && section(read(), "Goals") !== undefined) {
				ctx.ui.notify(prompts.oldFormat(state.file), "warning");
				retireReminder();
				state = { ...initial(state.owner), retired: state.retired }; persist();
			}
		} catch (error) { ctx.ui.notify(String(error), "error"); }
		resyncDue = Boolean(state.file);
		refresh(ctx);
		try {
			if (watched()) page = split(read()).page;
			cleanRetired(ctx);
			checkReminder(ctx);
		} catch (error) { ctx.ui.notify(String(error), "error"); }
	});
	pi.on("session_shutdown", async () => { generation++; stopReview?.abort(); });

	pi.registerTool({
		name: "CompleteGoal", label: "Complete goal", description: prompts.completeGoalDescription,
		parameters: Type.Object({}),
		async execute(_id, _params, signal, onUpdate, ctx) {
			if (state.phase !== "working") throw new Error("Choose Ready or resume the approved goal before completion.");
			if (judging) throw new Error("A goal review is already in progress.");
			const text = read();
			const current = generation;
			judging = true;
			try {
				const model = judgeModel(ctx);
				onUpdate?.(result(prompts.judgeProgress(state.judge)));
				const reviewed = state.judge ? await runJudge(pi.events, { task: signOffTask(text, state.file!, ctx.cwd, history(ctx)), schema: prompts.judgeSchema, cwd: ctx.cwd, model }, signal) : undefined;
				if (signal?.aborted || current !== generation) throw new Error("Review interrupted or goals session changed; no completion recorded.");
				if (read() !== text) throw new Error("The goals file changed during review; inspect the new requirements and review again.");
				const outcome = reviewed ? decideSignOff(reviewed) : { accepted: true, text: prompts.selfVerified, log: "self-verified (sign-off judge disabled)" };
				const report = join(ctx.cwd, ".pi/goals/reviews", `${randomUUID()}.json`);
				mkdirSync(dirname(report), { recursive: true });
				writeFileSync(report, JSON.stringify({ goals: text, result: reviewed ?? "self-verification", model }, null, 2));
				if (!outcome.accepted) return result([outcome.text, relative(ctx.cwd, report)].join("\n\n"));
				save(appendEvidence(text, `${stamp()} ${outcome.log}; ${relative(ctx.cwd, report)}`));
				state = { ...state, done: reviewed ? "accepted" : "self-verified" };
				pause(ctx);
				return result([outcome.text, relative(ctx.cwd, report), prompts.goalFinished(state.file!, section(text, "Result mock-up"))].join("\n\n"));
			} finally { judging = false; }
		},
	});
}
