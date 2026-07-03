/**
 * pi-goals v2 — plan mode drafts goals into one .pi/plan.md, the agent works them with its normal
 * Edit tool, and a fresh read-only judge signs each goal off through the one blessed tool,
 * CompleteGoal.
 *
 * The v1 lesson: the parser existed so TypeScript could read plan.md, but almost every reader is a
 * model. So v2 has NO parser and no schema. The harness does exactly three things for a
 * cooperative-but-confused model:
 *   1. memory  — inject plan.md verbatim every turn (survives compaction; byte-identical when
 *                unchanged so the KV cache holds; stale copies stripped by the context hook)
 *   2. format  — a skeleton convention taught in planDrafting (prompts.ts), not validated
 *   3. eyes    — CompleteGoal spawns a read-only pi subprocess (--no-session) that gets the whole
 *                plan file plus the claimed goal, finds the goal itself (tolerates wording drift),
 *                runs the goal's verify command itself, and returns VERDICT: accept|reject
 *
 * The judge subsumes what v1 did in code: goal matching (no findGoal), evidence validation (a
 * placeholder gets rejected in words), verify execution, and format reading. The extension's only
 * write is appending a sign-off line to ## Log — the audit trail. The agent ticks [x] itself; a
 * hand-tick without a matching tool-written log line is visible in the diff.
 *
 * Judge ran but failed/errored/timed out, or returned no VERDICT line => accepted_inconclusive: the
 * working agent is never blocked on judge infra; the log line says the judge ran but failed. There
 * is no pre-emptive "no model" path -- a null judgeModel just omits --model so pi's configured
 * default runs the judge, so inconclusive always means "ran but failed", never "couldn't start".
 *
 * All model-facing text lives in prompts.ts, in flow order.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { completeGoalDescription, completeGoalParamDescription, judgeSystem, judgeUser, planDrafting, reminder } from "./prompts.js";

const STATE = "pi-goals-state";
const PLAN_CONTEXT = "pi-goals-context"; // injected plan/guidance, stale copies stripped by the context hook
const STATUS_KEY = "pi-goals";
const WIDGET_KEY = "pi-goals-widget";
const PLAN_REL = ".pi/plan.md";
// Judge toolset: read-only inspection plus bash (git log, cat, running the goal's verify command).
// edit/write are excluded so the judge cannot modify anything. Names match pi's tool registry.
const JUDGE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const JUDGE_BLOCKED_TOOLS = ["edit", "write"];
const JUDGE_TIMEOUT_MS = 600_000;
// Plan mode is read-only by convention AND a light gate: edit/write are blocked (except plan.md,
// the deliverable). bash stays open — the prompt says don't mutate; guide, don't gate (spec D3).
const PLAN_MODE_BLOCKED_TOOLS = ["edit", "write"];

// The one regex in the whole extension: a checkbox line beginning "goal:", for the widget and the
// "any goals open?" reminder condition. Everything else reads the file as prose.
const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*goal:\s*(.*)$/i;
type GoalStatus = "open" | "active" | "done" | "cancelled";
const CHAR_TO_STATUS: Record<string, GoalStatus> = { " ": "open", "/": "active", x: "done", "-": "cancelled" };

function scanGoals(plan: string): Array<{ status: GoalStatus; subject: string }> {
	const goals: Array<{ status: GoalStatus; subject: string }> = [];
	for (const line of plan.split("\n")) {
		const m = GOAL_LINE.exec(line);
		if (m) goals.push({ status: CHAR_TO_STATUS[m[1].toLowerCase()] ?? "open", subject: m[2].trim() });
	}
	return goals;
}

interface PlanState {
	isPlanMode: boolean;
	/** Optional model ref for the sign-off judge; unset => current session model, else pi's default. */
	judgeModel: string | null;
}

export default function piGoalsExtension(pi: ExtensionAPI): void {
	let state: PlanState = { isPlanMode: false, judgeModel: null };
	// Reminder cadence: fire when goals are open but plan.md was untouched since the last turn.
	let lastInjectedPlan = "";

	const planPath = (ctx: ExtensionContext) => join(ctx.cwd, ".pi", "plan.md");
	const readPlan = (ctx: ExtensionContext): string => (existsSync(planPath(ctx)) ? readFileSync(planPath(ctx), "utf-8") : "");
	const writePlan = (ctx: ExtensionContext, content: string): void => {
		mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
		writeFileSync(planPath(ctx), content);
	};

	function persist(): void {
		pi.appendEntry<PlanState>(STATE, state);
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (state.isPlanMode) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "planning"));
			ctx.ui.setWidget(WIDGET_KEY, [`pi-goals: drafting goals in ${PLAN_REL}`]);
			return;
		}
		const goals = scanGoals(readPlan(ctx));
		if (goals.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const done = goals.filter((g) => g.status === "done").length;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◷ ${done}/${goals.length} goals`));
		const mark: Record<GoalStatus, string> = { done: "✔", active: "▸", open: "◻", cancelled: "✗" };
		// Only live goals get lines so finished work never pushes current work off screen.
		const live = goals.filter((g) => g.status === "active" || g.status === "open");
		ctx.ui.setWidget(WIDGET_KEY, [ctx.ui.theme.fg("muted", PLAN_REL), ...live.map((g) => `${mark[g.status]} ${g.subject}`)]);
	}

	// --- /goals: enter plan mode (or clear / set judge) --------------------------------------------

	pi.registerCommand("goals", {
		description: `Plan mode: draft goals into ${PLAN_REL}, review, then work them. /goals <objective> | /goals clear | /goals judge <model>`,
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "clear") {
				writePlan(ctx, "");
				state = { ...state, isPlanMode: false };
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`Cleared ${PLAN_REL}.`, "info");
				return;
			}
			if (arg.startsWith("judge")) {
				const ref = arg.slice("judge".length).trim();
				state = { ...state, judgeModel: ref || null };
				persist();
				ctx.ui.notify(ref ? `Sign-off judge model set to ${ref}` : "Sign-off judge reset to the session model", "info");
				return;
			}
			state = { ...state, isPlanMode: true };
			persist();
			updateWidget(ctx);
			const seed = arg
				? `We're in plan mode. Objective: ${arg}\n\nExplore the repo read-only and ask me anything unclear. When the objective is nailed down, draft (or replace) the plan in ${planPath(ctx)}, then stop for review.`
				: `We're in plan mode. Tell me what you want to plan. Explore read-only and ask questions as needed; when the objective is clear, draft the plan in ${planPath(ctx)} and stop for review.`;
			pi.sendUserMessage(seed, { deliverAs: "followUp" });
		},
	});

	// --- hooks --------------------------------------------------------------------------------------

	pi.on("before_agent_start", async (_event, ctx) => {
		if (state.isPlanMode) {
			return { message: { customType: PLAN_CONTEXT, content: `${planDrafting}\n\nWrite the plan to ${planPath(ctx)}.`, display: false } };
		}
		const plan = readPlan(ctx);
		const goals = scanGoals(plan);
		if (goals.length === 0) return;
		// The plan file itself IS the injection: no parsing, no summarizing, the model sees the
		// literal file it edits. Byte-identical when unchanged, so the prefix cache holds.
		let body = `Current plan (${PLAN_REL}; keep it updated with your edit tool):\n\n${plan}`;
		const live = goals.some((g) => g.status === "active" || g.status === "open");
		if (live && plan === lastInjectedPlan) body += `\n\n${reminder}`;
		lastInjectedPlan = plan;
		return { message: { customType: PLAN_CONTEXT, content: body, display: false } };
	});

	// Plan mode gate: block edit/write except on plan.md itself. bash stays open (guide, not gate).
	pi.on("tool_call", async (event, ctx) => {
		if (!state.isPlanMode) return;
		if (PLAN_MODE_BLOCKED_TOOLS.includes(event.toolName)) {
			const target = (event.input as { path?: string }).path;
			if (target && resolve(ctx.cwd, target) === resolve(planPath(ctx))) return;
			return { block: true, reason: `Plan mode is read-only: only ${PLAN_REL} may be written while drafting. Agree the goals first, then choose Ready.` };
		}
	});

	// After a plan-mode turn: if goals were drafted, offer Ready. No edit menus, no fresh-session
	// dance — the human reads the file and says go (or keeps talking to revise it).
	pi.on("agent_end", async (_event, ctx) => {
		if (!state.isPlanMode || !ctx.hasUI) return;
		if (scanGoals(readPlan(ctx)).length === 0) return; // still exploring/asking; nothing to review yet
		const choice = await ctx.ui.select(`Plan drafted in ${PLAN_REL}. Ready?`, [
			"Ready — start working the plan",
			"Keep planning (reply to revise)",
		]);
		if (!choice?.startsWith("Ready")) return;
		state = { ...state, isPlanMode: false };
		persist();
		updateWidget(ctx);
		pi.sendUserMessage(
			`Work the goals in ${planPath(ctx)}. Pick an open goal, mark it active ([/]), work its subtasks, and when its discriminator is satisfied fill its evidence: list, then call CompleteGoal with the goal's text. Keep the plan file current as you go.`,
			{ deliverAs: "followUp" },
		);
	});

	// Keep only the freshest injected plan; strip stale ones so history doesn't bloat and the model
	// never sees an out-of-date plan.
	pi.on("context", async (event) => {
		const isCtx = (m: unknown) => (m as { customType?: string }).customType === PLAN_CONTEXT;
		let lastIdx = -1;
		event.messages.forEach((m, i) => {
			if (isCtx(m)) lastIdx = i;
		});
		return { messages: event.messages.filter((m, i) => !isCtx(m) || i === lastIdx) };
	});

	pi.on("session_start", async (_event, ctx) => {
		// v1 wrote .pi/goals.md; v2 reads .pi/plan.md. Rename so old goals aren't silently invisible
		// (dogfood finding). Claude: one-time migration, delete once v1 files are gone from the wild.
		const v1Path = join(ctx.cwd, ".pi", "goals.md");
		if (existsSync(v1Path) && !existsSync(planPath(ctx))) {
			renameSync(v1Path, planPath(ctx));
			ctx.ui.notify(`Renamed .pi/goals.md -> ${PLAN_REL} (v2 filename).`, "info");
		}
		const last = ctx.sessionManager
			.getEntries()
			.filter((e: { type?: string; customType?: string }) => e.type === "custom" && e.customType === STATE)
			.pop() as { data?: PlanState } | undefined;
		if (last?.data) state = { ...state, ...last.data };
		updateWidget(ctx);
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
			const plan = readPlan(ctx);
			if (!plan.trim()) return result(`No plan file at ${PLAN_REL}.`, true);

			const judgeModel = state.judgeModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
			onUpdate?.({ content: [{ type: "text", text: `Read-only judge (${judgeModel ?? "pi default"}) inspecting: ${params.goal}` }], details: {} });
			// decideSignOff runs the judge and derives the outcome + the one log line. judgeModel is never
			// checked pre-emptively: null just means pi's configured default runs (buildJudgeArgs omits
			// --model), so accepted_inconclusive always means "the judge ran but failed", never "no model".
			const outcome = await decideSignOff(
				{ goal: params.goal, plan, judgeModel },
				signal,
				(task) => runJudge(task, judgeModel, ctx.cwd, signal),
			);
			if (outcome.logEntry) {
				writePlan(ctx, appendLog(readPlan(ctx), `${stamp()} ${outcome.logEntry}`));
				updateWidget(ctx);
			}
			return result(outcome.resultText, outcome.isError);
		},
	});
}

// --- helpers (module scope) --------------------------------------------------------------------

function result(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
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

/** A judge run's result: stdout output, plus an error string when the subprocess failed/timed out. */
export interface JudgeResult {
	output: string;
	error?: string;
}

/** Inputs to a sign-off decision. judgeModel is null when no explicit/session model is set. */
export interface SignOffInput {
	goal: string;
	plan: string;
	judgeModel: string | null;
}

/** The outcome of a sign-off: the reply text, whether it's a hard error, and the one ## Log line to
 *  append (null when nothing should be written, e.g. aborted before any verdict). */
export interface SignOffOutcome {
	resultText: string;
	isError: boolean;
	logEntry: string | null;
}

/** Run the judge and decide accept / reject / accepted_inconclusive. Pure aside from the injected
 *  judge runner, so the unit test can lock the fail-forward invariant: judgeModel is NEVER checked
 *  here, so a null model still reaches runJudge (pi's configured default runs it), and the only
 *  producers of accepted_inconclusive are the judge-error and no-VERDICT paths -- i.e. "the judge
 *  ran but failed", never "no model". The execute() wrapper does the plan-file write + widget.
 *  Exported for the unit test that locks this invariant. */
export async function decideSignOff(
	input: SignOffInput,
	signal: AbortSignal | undefined,
	runJudgeFn: (task: string) => Promise<JudgeResult>,
): Promise<SignOffOutcome> {
	const task = judgeUser({ goal: input.goal, plan: input.plan, planPath: PLAN_REL });
	const judge = await runJudgeFn(task);

	if (signal?.aborted) return { resultText: "Sign-off aborted.", isError: true, logEntry: null };

	// Judge ran but failed/errored/timed out: fail forward, say so in the log.
	if (judge.error) {
		const partial = judge.output ? `\n\npartial judge output:\n${judge.output}` : "";
		return {
			resultText: `Judge ran but failed (${judge.error}). Accepted inconclusive — logged. Tick the goal [x] in ${PLAN_REL} yourself.${partial}`,
			isError: false,
			logEntry: `signed off "${input.goal}" (judge inconclusive: ran but failed: ${oneLine(judge.error)})`,
		};
	}

	const verdictLine = judge.output.split("\n").find((l) => /^\s*VERDICT\s*:/i.test(l)) ?? "";
	const verdict = /^\s*VERDICT\s*:\s*(accept|reject)\s*$/i.exec(verdictLine)?.[1]?.toLowerCase();
	const reasoning = judge.output.length > 2000 ? `...\n${judge.output.slice(-2000)}` : judge.output;

	if (verdict === "accept") {
		return {
			resultText: `Sign-off ACCEPTED. Tick the goal [x] in ${PLAN_REL} (the log line is already appended).\n\n--- judge ---\n${reasoning}`,
			isError: false,
			logEntry: `signed off "${input.goal}" (judge accept)`,
		};
	}
	if (verdict === "reject") {
		const missing = judge.output.match(/missing\s*:\s*([\s\S]*)$/i)?.[1].trim() || judge.output.slice(-500);
		return {
			resultText: `Sign-off REJECTED. Missing:\n${missing}\n\n--- judge ---\n${reasoning}`,
			isError: true,
			logEntry: `reject "${input.goal}": ${oneLine(missing)}`,
		};
	}
	// No VERDICT line: same fail-forward as a judge error -- the judge ran but didn't answer.
	return {
		resultText: `Judge returned no VERDICT line. Accepted inconclusive — logged. Tick the goal [x] in ${PLAN_REL} yourself.\n\n--- judge ---\n${reasoning || "(no output)"}`,
		isError: false,
		logEntry: `signed off "${input.goal}" (judge inconclusive: no VERDICT line)`,
	};
}

/** Append one line under ## Log (creating the section at EOF if absent). The extension's only write. */
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

/** Build the pi argv for the read-only judge. `--model` is omitted when no explicit/session model is
 *  set, so pi falls back to its configured default — the judge always runs. `--no-extensions` keeps
 *  the judge minimal and immune to a broken third-party extension taking down every sign-off.
 *  Exported for the unit test that locks these invariants. */
export function buildJudgeArgs(judgeModel: string | null): string[] {
	const args = ["-p", "--no-session", "--no-extensions"];
	if (judgeModel) args.push("--model", judgeModel);
	args.push("--tools", JUDGE_TOOLS.join(","), "--exclude-tools", JUDGE_BLOCKED_TOOLS.join(","), "--append-system-prompt", judgeSystem);
	return args;
}

/** Locate the pi binary the same way the oracle extension does, so spawning works under bun or node. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** Spawn the read-only judge subprocess (plain `pi -p`: stdout is the final response text). */
async function runJudge(
	task: string,
	judgeModel: string | null,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<JudgeResult> {
	const args = buildJudgeArgs(judgeModel);
	args.push(task);
	const inv = getPiInvocation(args);
	// Runs in-place against this checkout; pi --no-session does not clone into the parent
	// (proven by scripts/check-judge-footprint.sh).
	return new Promise((resolvePromise) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		const done = (r: { output: string; error?: string }) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolvePromise(r);
			}
		};
		const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], signal });
		const timer = setTimeout(() => {
			proc.kill();
			done({ output: stdout.trim(), error: `judge timed out after ${JUDGE_TIMEOUT_MS / 1000}s` });
		}, JUDGE_TIMEOUT_MS);
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			if ((code ?? 0) !== 0) done({ output: stdout.trim(), error: stderr.trim() || `judge subprocess exited ${code ?? 1}` });
			else done({ output: stdout.trim() });
		});
		proc.on("error", (e) => done({ output: stdout.trim(), error: `judge subprocess failed: ${e.message}` }));
	});
}
