// PI/OpenAI: one agent, one goals file, human Ready, and a stock scheduled loop.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendInterview, appendLog, foldGoals, goals, hasRemainingGoals, markGoal, section, stamp, widgetLines, withoutSection } from "./goals.js";
import { decideSignOff, runJudge } from "./judge.js";
import { startLoop, stopLoop, wakeToken } from "./loop.js";
import * as prompts from "./prompts.js";

const STATE = "pi-goals-single-agent";
interface State {
	owner: string;
	phase: "planning" | "working" | "paused" | null;
	file?: string;
	/** Identifies this Ready's scheduled wakes; older or foreign wakes are dropped. */
	token?: string;
	judge: boolean;
	model?: string;
}
const initial = (owner: string): State => ({ owner, phase: null, judge: true });
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const handled = { action: "handled" as const };

export default function piGoals(pi: ExtensionAPI): void {
	let state = initial("");
	let generation = 0;
	let reviewRequested = false;
	let resyncDue = false;
	let reviewing = false;
	let judging = false;
	const persist = () => pi.appendEntry(STATE, { ...state });
	const read = () => readFileSync(state.file!, "utf8");
	const save = (text: string) => writeFileSync(state.file!, text);

	function refresh(ctx: ExtensionContext) {
		if (!state.file) {
			ctx.ui.setStatus("goals", undefined);
			ctx.ui.setWidget("goals", undefined);
			return;
		}
		try {
			const text = read();
			const items = goals(text);
			ctx.ui.setStatus("goals", `${state.phase} · ${items.filter(g => g.status === "done").length}/${items.length} accepted`);
			ctx.ui.setWidget("goals", widgetLines(text, relative(ctx.cwd, state.file)));
		} catch (error) { ctx.ui.setWidget("goals", [String(error)]); }
	}

	function pause(ctx: ExtensionContext) {
		const token = state.token;
		state = { ...state, phase: "paused", token: undefined };
		generation++;
		persist();
		refresh(ctx);
		if (!token) return;
		try { stopLoop(pi, ctx, token); } catch (error) { ctx.ui.notify(String(error), "error"); }
	}

	function begin(ctx: ExtensionContext) {
		const text = read();
		if (!section(text, "Loop statement") || !hasRemainingGoals(text, state.judge)) throw new Error("The goals file needs a Loop statement and unfinished goals.");
		const token = randomUUID();
		startLoop(pi, ctx, token);
		state = { ...state, phase: "working", token };
		generation++;
		persist();
		refresh(ctx);
		pi.sendUserMessage(prompts.readyPrompt(state.file!), { deliverAs: "followUp" });
	}

	async function review(ctx: ExtensionContext) {
		if (reviewing || state.phase !== "planning" || !ctx.hasUI) return;
		reviewing = true;
		const current = generation;
		try {
			while (current === generation) {
				const text = read();
				if (!goals(text).length || !section(text, "Loop statement")) throw new Error("Draft the goals and Loop statement before requesting Ready.");
				pi.sendMessage({ customType: "goals-draft", content: text, display: true });
				const choice = await ctx.ui.select(`Goals: ${relative(ctx.cwd, state.file!)}`, ["Ready", "Refine", "Edit", "Cancel"]);
				if (current !== generation) return;
				if (choice === "Ready") return begin(ctx);
				if (choice === "Edit") {
					const edited = await ctx.ui.editor("Edit goals", text);
					if (current !== generation) return;
					if (edited !== undefined) save(edited);
					continue;
				}
				if (choice === "Refine") {
					const notes = await ctx.ui.editor("What should change?", "");
					if (current !== generation) return;
					if (!notes?.trim()) continue;
					save(appendInterview(read(), notes));
					pi.sendUserMessage(prompts.refine(state.file!, notes), { deliverAs: "followUp" });
				}
				if (choice === "Cancel") { state = initial(state.owner); generation++; persist(); refresh(ctx); }
				return;
			}
		} finally { reviewing = false; }
	}

	pi.registerCommand("goals", {
		description: "Goals: new [idea], review, pause, resume, clear, judge [off|on|provider/model]",
		handler: async (args, ctx) => {
			try {
				let arg = args.trim();
				if (!arg) arg = (await ctx.ui.select("Goals", state.file ? ["review", "pause", "resume", "clear"] : ["new"])) ?? "";
				if (!arg) return;
				if (arg === "clear") {
					if (state.token) pause(ctx);
					state = initial(ctx.sessionManager.getSessionId());
					generation++; resyncDue = false; reviewRequested = false;
					persist(); refresh(ctx); return;
				}
				if (arg === "pause") { if (state.phase === "working") pause(ctx); return; }
				if (arg === "resume") { if (state.phase !== "paused") throw new Error("Only paused goals can resume."); begin(ctx); return; }
				if (arg === "review") { await review(ctx); return; }
				if (arg === "judge" || arg.startsWith("judge ")) {
					const value = arg.slice(5).trim();
					state = { ...state, judge: value !== "off", model: ["", "on", "off"].includes(value) ? undefined : value };
					persist(); ctx.ui.notify(`Judge ${state.judge ? state.model ?? "uses the session model" : "disabled: completion is self-verification"}.`, "info"); return;
				}
				if (arg !== "new" && !arg.startsWith("new ")) throw new Error("Use /goals new [idea], review, pause, resume, clear, or judge.");
				if (state.file) throw new Error("Clear the current goals before starting new ones; the file is preserved.");
				const file = join(ctx.cwd, ".pi/goals", `${ctx.sessionManager.getSessionId()}-${randomUUID().slice(0, 8)}.md`);
				mkdirSync(dirname(file), { recursive: true });
				const idea = arg.slice(3).trim();
				// Slash commands skip the input hook; keep the user's opening words verbatim too.
				writeFileSync(file, idea ? appendInterview("", `/goals new ${idea}`).trimStart() : "");
				state = { ...state, owner: ctx.sessionManager.getSessionId(), phase: "planning", file };
				generation++; reviewRequested = false; resyncDue = false;
				persist(); refresh(ctx);
				pi.sendUserMessage(prompts.draft(file, idea), { deliverAs: "followUp" });
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});

	pi.registerTool({
		name: "RequestPlanReview", label: "Review goals", description: prompts.requestReview,
		parameters: Type.Object({}),
		async execute() {
			if (state.phase !== "planning") throw new Error("No goals discussion is active.");
			reviewRequested = true;
			return result(prompts.reviewQueued);
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!reviewRequested) return;
		reviewRequested = false;
		try { await review(ctx); } catch (error) { ctx.ui.notify(String(error), "error"); }
	});

	pi.on("input", async (event, ctx) => {
		const token = event.source === "extension" ? wakeToken(event.text) : undefined;
		if (token) {
			if (token !== state.token || state.phase !== "working") return handled;
			const text = read();
			if (!hasRemainingGoals(text, state.judge)) { pause(ctx); return handled; }
			const statement = section(text, "Loop statement");
			if (!statement) throw new Error(`${state.file} has no Loop statement.`);
			return { action: "transform" as const, text: prompts.loopPrompt(statement, withoutSection(foldGoals(text), "Loop statement"), state.file!) };
		}
		if (state.phase === "planning" && event.source !== "extension") save(appendInterview(read(), event.text));
	});

	// Whole goals file after compaction or resume: persisted at the next prompt, or transient once if an
	// auto-compaction retry continues the run without before_agent_start.
	const resyncText = () => [state.phase === "planning" ? prompts.planningState(state.file!) : "", prompts.resync(read(), state.file!, "Session started or compacted.")].filter(Boolean).join("\n\n");
	pi.on("before_agent_start", async () => {
		if (!state.file || !resyncDue) return;
		resyncDue = false;
		return { message: { customType: "goals-context", content: resyncText(), display: false } };
	});
	pi.on("context", async (event) => {
		if (!state.file || !resyncDue) return;
		resyncDue = false;
		return { messages: [...event.messages, { role: "user" as const, content: [{ type: "text" as const, text: resyncText() }], timestamp: Date.now() }] };
	});
	pi.on("session_compact", async () => { resyncDue = true; });
	pi.on("turn_end", async (_event, ctx) => { refresh(ctx); });
	pi.on("tool_call", async (event, ctx) => {
		// Planning allows exploration; only file edits outside the goals file and completion are blocked.
		if (state.phase !== "planning" || !["write", "edit", "CompleteGoal"].includes(event.toolName)) return;
		if (event.toolName !== "CompleteGoal" && resolve(ctx.cwd, String((event.input as { path?: string }).path)) === state.file) return;
		return { block: true, reason: prompts.planningState(state.file!) };
	});
	pi.on("session_start", async (_event, ctx) => {
		generation++; reviewRequested = false;
		const last = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === STATE).at(-1);
		const saved = last?.type === "custom" ? last.data as State : undefined;
		state = saved?.owner === ctx.sessionManager.getSessionId() ? saved : initial(ctx.sessionManager.getSessionId());
		resyncDue = Boolean(state.file);
		refresh(ctx);
	});
	pi.on("session_shutdown", async () => { generation++; });

	pi.registerTool({
		name: "CompleteGoal", label: "Complete goal", description: prompts.completeGoalDescription,
		parameters: Type.Object({ goal: Type.String({ description: prompts.completeGoalParamDescription }) }),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (state.phase !== "working") throw new Error("Choose Ready or resume approved goals before completion.");
			if (judging) throw new Error("A goal review is already in progress.");
			const text = read();
			if (!markGoal(text, params.goal, "✓")) throw new Error("Use one exact, unique goal subject.");
			const current = generation;
			judging = true;
			try {
				const model = state.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
				onUpdate?.(result(prompts.judgeProgress(params.goal, state.judge)));
				const reviewed = state.judge ? await runJudge(pi.events, { goal: params.goal, text, path: state.file!, cwd: ctx.cwd, model }, signal) : undefined;
				if (signal?.aborted || current !== generation) throw new Error("Review interrupted or goals session changed; no completion recorded.");
				if (read() !== text) throw new Error("Goals changed during review; inspect the new requirements and review again.");
				const outcome = reviewed ? decideSignOff(params.goal, reviewed) : { mark: "x" as const, text: prompts.selfVerified, log: `self-verified "${params.goal}" (judge disabled)` };
				const report = join(ctx.cwd, ".pi/goals/reviews", `${randomUUID()}.json`);
				mkdirSync(dirname(report), { recursive: true });
				writeFileSync(report, JSON.stringify({ goal: params.goal, goals: text, result: reviewed ?? "self-verification", model }, null, 2));
				const updated = outcome.mark ? markGoal(text, params.goal, outcome.mark)! : text;
				save(appendLog(updated, `${stamp()} ${outcome.log}; ${relative(ctx.cwd, report)}`));
				refresh(ctx);
				if (!hasRemainingGoals(updated, state.judge)) pause(ctx);
				return result(`${outcome.text}\n\n${relative(ctx.cwd, report)}`);
			} finally { judging = false; }
		},
	});
}
