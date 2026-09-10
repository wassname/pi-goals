/** Opt-in prototype: the existing chat plans and supervises an edxeth interactive worker. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { foldPlan, GOAL_LINE } from "./plan.js";

const STATE = "pi-goals-main-supervisor-v1";
const WORKER = "goals-worker";
type Mode = "chat" | "planning" | "supervising" | "paused" | "solo";
interface State {
	mode: Mode;
	plan?: string;
	worker?: { id: string; sessionFile: string };
	signoffs: Record<string, { evidence: string[]; observation: string }>;
	child?: boolean;
}
const initial = (): State => ({ mode: "chat", signoffs: {} });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (text: string) => text.trim().toLowerCase();
function goals(text: string) {
	return foldPlan(text).split("\n").flatMap((line, index) => {
		const match = GOAL_LINE.exec(line);
		return match ? [{ subject: match[2].trim(), checked: /x/i.test(match[1]), index }] : [];
	});
}
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function mainSupervisor(pi: ExtensionAPI) {
	let state = initial();
	let generation = 0;
	let notice = true;
	const childEnvironment = process.env.PI_SUBAGENT_AGENT === WORKER;
	const save = () => pi.appendEntry(STATE, state);
	const planText = () => {
		try { return state.plan ? readFileSync(state.plan, "utf8") : ""; } catch { return ""; }
	};
	function refresh(ctx: ExtensionContext) {
		const items = goals(planText());
		// Reopened/deleted/ambiguous goal identities lose their sign-off. Manual ticks remain claims.
		for (const subject of Object.keys(state.signoffs)) {
			const matches = items.filter((g) => key(g.subject) === subject);
			if (matches.length !== 1 || !matches[0].checked) { delete state.signoffs[subject]; save(); }
		}
		const accepted = items.filter((g) => g.checked && state.signoffs[key(g.subject)]).length;
		ctx.ui.setStatus("goals", state.mode === "chat" ? undefined : `goals: ${state.child ? "worker" : state.mode} | ${accepted}/${items.length} reviewed`);
		ctx.ui.setWidget("goals", state.mode === "chat" ? undefined : [
			...items.map((g) => `${state.signoffs[key(g.subject)] && g.checked ? "✓" : g.checked ? "?" : "○"} ${g.subject}`),
			...(items.some((g) => g.checked && !state.signoffs[key(g.subject)]) ? ["? = completion claim; parent review still required"] : []),
		]);
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
			state.plan = process.env.PI_GOALS_SHARED_PLAN || state.plan;
			save();
		}
		notice = true;
		refresh(ctx);
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
	const help = "/goals <objective> | review | ready | status | stop | resume | solo | exit\n/subagents opens edxeth's worker UI. Stop/exit pause this plan locally; worker termination must be confirmed through subagent_kill or its pane. No forced compaction or model switch.";
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
			if (choice === "Discuss") { send("Discuss the current draft in ordinary chat. Do not launch a worker or reopen the review menu until requested."); return; }
			if (choice === "Edit") {
				const edited = await ctx.ui.editor("Edit goal plan", text);
				if (edited !== undefined && stamp === generation && planText() === text && state.plan) { writeFileSync(state.plan, edited); refresh(ctx); }
				return;
			}
			if (choice !== "Ready") return;
		}
		if (!compatible()) { ctx.ui.notify("Requires edxeth/pi-subagents 2.9.x, not nicobailon/pi-subagents. Draft preserved; /goals solo is available.", "error"); return; }
		state.mode = "supervising"; generation++; notice = true; save(); refresh(ctx);
		send(`Ready approved this plan: ${state.plan}. Stay in this chat as supervisor. Delegate the first open goal to agent '${WORKER}' with subagent; provide name, title and task. Include the absolute plan path in the task. Do not start a second writer. Inspect actual outputs when the child reports.\n\n${text}`);
	}

	pi.on("session_start", (_e, ctx) => restore(ctx));
	pi.on("session_tree", (_e, ctx) => restore(ctx));
	pi.on("session_compact", () => { notice = true; });
	pi.on("agent_end", (_e, ctx) => refresh(ctx));
	// No context hook. Historical message arrays, native checkpoints and model selection are untouched.
	pi.on("before_agent_start", (event) => {
		if (state.child || state.mode === "chat") return;
		const role = state.mode === "supervising"
			? `You are the goal supervisor in the main chat. Inspect files, evidence and applicable AGENTS/skills yourself; delegate implementation to '${WORKER}'. Investigate blocked/waiting/done claims rather than accepting them. Change ineffective instructions. Keep authorized work moving until the requested result is inspected, not merely until approval paperwork exists. Use edxeth subagent for first launch and subagent_resume with the returned sessionFile for follow-up; never duplicate a live writer. Worker reports arrive automatically. A recap alone sends no instruction. When a worker finishes a goal, inspect the actual artifact and saved verification, call CompleteGoal, then resume it for the next open goal. Retain brief visible assessments. Do not enable edxeth's tool-restricted orchestrator mode.`
			: state.mode === "planning"
				? `Plan only. Ask material unresolved questions, not a quota. Draft ${state.plan} with objective, preferences, distinct '- [ ] goal: ...' subjects, failure modes and evidence/verification for each. Keep goal lines and evidence references above ## Log. Do not implement, launch workers or treat your own draft as approved. Present it for /goals review or /goals ready.`
				: state.mode === "paused"
					? "Goal work is paused. Do not launch, resume or authorize work. Incoming worker reports are observations, not permission to continue. Help inspect or stop existing workers if requested."
					: "Solo mode: this chat may implement the approved plan directly. Do not delegate a concurrent writer. Verify artifacts before CompleteGoal.";
		const message = notice ? { customType: "pi-goals-plan", content: `Current goal mode: ${state.mode}. Earlier role messages are historical; this current role governs.\nPlan: ${state.plan}\n${planText()}`, display: false } : undefined;
		notice = false;
		return { systemPrompt: `${event.systemPrompt}\n\n${role}`, ...(message ? { message } : {}) };
	});
	pi.on("tool_call", (event) => {
		if (state.child || !["subagent", "subagent_resume"].includes(event.toolName)) return;
		if (state.mode === "planning" || state.mode === "paused") return { block: true, reason: `Goals are ${state.mode}; no worker launch/resume authorized.` };
	});
	pi.on("tool_result", (event) => {
		if (state.child || state.mode !== "supervising" || !["subagent", "subagent_resume"].includes(event.toolName) || event.isError) return;
		const details = event.details as { id?: string; sessionFile?: string } | undefined;
		if (details?.id && details.sessionFile) { state.worker = { id: details.id, sessionFile: details.sessionFile }; save(); }
	});

	pi.registerCommand("goals", {
		description: "Prototype: plan here, supervise a visible edxeth worker",
		handler: async (args, ctx) => {
			if (state.child) { ctx.ui.notify("This is the delegated worker. Goal approval belongs to its parent.", "info"); return; }
			const command = args.trim();
			if (!command || command === "help") { ctx.ui.notify(help, "info"); return; }
			if (command === "status") { refresh(ctx); ctx.ui.notify(`${state.mode}\nPlan: ${state.plan ?? "none"}\nWorker session: ${state.worker?.sessionFile ?? "not recorded"}\nLiveness is owned by edxeth; inspect /subagents.`, "info"); return; }
			if (command === "review" || command === "ready") { await ready(ctx, command === "review"); return; }
			if (command === "stop" || command === "exit") {
				state.mode = command === "stop" ? "paused" : "chat"; generation++; notice = true; save(); refresh(ctx);
				send(`Goals ${command === "stop" ? "paused" : "exited to ordinary chat"} locally; plan and evidence retained. ${state.worker ? `Use subagent_kill with id ${JSON.stringify(state.worker.id)} to stop the tracked worker, and confirm the result. Do not resume it.` : "No worker recorded. Inspect /subagents if a launch was interrupted."} Remote stop is NOT yet confirmed.`, Boolean(state.worker)); return;
			}
			if (command === "resume") {
				if (state.mode !== "paused" || !state.plan) { ctx.ui.notify("Only a paused approved plan can resume. A draft needs Ready.", "warning"); return; }
				if (!compatible()) { ctx.ui.notify("edxeth tools unavailable; plan remains paused.", "error"); return; }
				state.mode = "supervising"; generation++; notice = true; save(); refresh(ctx);
				send(`User authorized continuation. Inspect worker state in /subagents before any launch. ${state.worker ? `Continue the existing session with subagent_resume: ${state.worker.sessionFile}.` : `Use subagent with '${WORKER}' only if no prior worker exists.`} Continue only unfinished goals in ${state.plan}.`); return;
			}
			if (command === "solo") {
				if (!state.plan || !goals(planText()).length) { ctx.ui.notify("Register a goal plan first.", "warning"); return; }
				if (state.worker) { ctx.ui.notify("Stop and inspect the existing worker first. Solo takeover is deliberately not automatic; use /goals exit and ordinary chat after confirming it stopped.", "warning"); return; }
				state.mode = "solo"; generation++; notice = true; save(); refresh(ctx); send(`User explicitly authorized solo work on ${state.plan}. No worker has been recorded; inspect /subagents if a launch previously failed.`); return;
			}
			if (state.worker || state.mode === "supervising") { ctx.ui.notify("Exit and resolve the existing worker before replacing the plan. The current plan is preserved.", "warning"); return; }
			const path = join(ctx.cwd, ".pi", "plan", `${ctx.sessionManager.getSessionId()}-main.md`);
			mkdirSync(dirname(path), { recursive: true });
			// Never overwrite an earlier plan at this session path; the model can revise it after inspection.
			try { readFileSync(path); } catch { writeFileSync(path, `# Goal plan\n\n## Objective\n${command}\n\n## Goals\n\n## Log\n`); }
			state = { mode: "planning", plan: path, signoffs: {} }; generation++; notice = true; save(); refresh(ctx);
			send(`Draft or revise ${path} for this objective: ${command}. Read any existing plan first. Ask only material questions; no implementation before Ready.`);
		},
	});
	pi.registerTool({
		name: "CompleteGoal", label: "Review goal evidence",
		description: "Parent-only recorded judgment, not an independent judge. Inspect the actual artifact and saved verification first; cite nonempty evidence files and describe what you observed. Exact goal subject required. Ignored/uncommitted evidence is allowed. Manual ticks are claims. Do not use this merely because the worker reports success.",
		parameters: Type.Object({ goal: Type.String(), evidence: Type.Array(Type.String(), { minItems: 1 }), observation: Type.String({ minLength: 1 }) }),
		async execute(_id, params, signal, _update, ctx) {
			if (state.child || !["supervising", "solo"].includes(state.mode)) return result("Completion is available only to the active parent supervisor or solo worker.");
			if (signal?.aborted) return result("Cancelled; no sign-off recorded.");
			const text = planText();
			const matches = goals(text).filter((g) => key(g.subject) === key(params.goal));
			if (matches.length !== 1 || !state.plan) return result("Use one unique exact goal subject from the plan; no sign-off recorded.");
			const evidence = params.evidence.map((file) => isAbsolute(file) ? file : resolve(ctx.cwd, file));
			try { for (const file of evidence) if (!readFileSync(file).length) throw new Error(`Empty evidence: ${file}`); }
			catch (error) { return result(`Evidence unavailable: ${String(error)}. No sign-off recorded.`); }
			const lines = text.split("\n");
			lines[matches[0].index] = lines[matches[0].index].replace(/\[[ xX/-]\]/, "[x]");
			if (!/^##\s+Log\s*$/im.test(text)) lines.push("\n## Log");
			writeFileSync(state.plan, `${lines.join("\n").trimEnd()}\n\n- Parent review: ${JSON.stringify(params.goal)}; ${JSON.stringify(params.observation)}; evidence ${JSON.stringify(evidence)}\n`);
			state.signoffs[key(matches[0].subject)] = { evidence, observation: params.observation };
			save(); refresh(ctx);
			return result(`Recorded parent judgment for ${matches[0].subject}. This is not independent verification. Continue supervising any remaining open or unsigned goals.`);
		},
	});
}
