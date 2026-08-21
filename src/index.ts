/**
 * pi-goals v2 — plan mode drafts goals into .pi/plan/<session_id>.md, the agent works them with its
 * normal Edit tool, and a fresh read-only judge signs each goal off through the one blessed tool,
 * CompleteGoal.
 *
 * One plan file per session, not per repo: two windows on one checkout, and any subagent (pi spawns
 * those with --no-session, extensions ON), each resolve a different path, so they can't read or
 * stomp each other's plan. The file name is also the arm switch: a session that never ran /goals has
 * no file at its path, so the widget, the injections and CompleteGoal all stay silent. The id is
 * stable exactly where it must be -- a resume reads it back from the session header, and a
 * compaction keeps it; only an explicit fork/new session gets a new one.
 *
 * The v1 lesson: the parser existed so TypeScript could read the plan, but almost every reader is a
 * model. So v2 has NO parser and no schema. The harness does exactly three things for a
 * cooperative-but-confused model:
 *   1. memory  — a transient re-send of the plan, never persisted, on two triggers: the plan went
 *                stale for STALE_TURNS turns (send the working set above ## Log), or the session
 *                started / compacted (send the whole file, appendix included). v2 sent the whole
 *                file every turn; pi-tasks tried that and deleted it as "wallpaper noise that
 *                trains the model to ignore the task block" (tintinweb/pi-tasks CHANGELOG.md:149),
 *                and the always-present CompleteGoal description carries the contract instead.
 *   2. format  — a skeleton convention taught in planDrafting (prompts.ts), not validated
 *   3. eyes    — CompleteGoal spawns a strictly read-only pi subprocess (--no-session, no bash)
 *                that gets the whole plan file plus the claimed goal, finds the goal itself
 *                (tolerates wording drift), checks the evidence (including the agent's saved
 *                verify output) against the repo, and returns VERDICT: accept|reject
 *
 * The judge subsumes what v1 did in code: goal matching (no findGoal), evidence validation (a
 * placeholder gets rejected in words), and format reading. The extension's only
 * writes are the sign-off: append a log line to ## Log (the audit trail) and tick the goal [x] when
 * an exact goal line matches (on drift the agent ticks, and the result says so). A hand-tick
 * without a matching tool-written log line is visible in the diff either way.
 *
 * Judge ran but failed/errored/timed out, or returned no VERDICT line => accepted_inconclusive: the
 * working agent is never blocked on judge infra; the log line says the judge ran but failed. There
 * is no pre-emptive "no model" path -- a null judgeModel just omits --model so pi's configured
 * default runs the judge, so inconclusive always means "ran but failed", never "couldn't start".
 *
 * All model-facing text lives in prompts.ts, in flow order.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { completeGoalDescription, completeGoalParamDescription, judgeSystem, judgeUser, planDrafting, reminder, resync } from "./prompts.js";

const STATE = "pi-goals-state";
const STATUS_KEY = "pi-goals";
const WIDGET_KEY = "pi-goals-widget";
const PLAN_DIR = ".pi/plan";
// For static text (the /goals description) where there is no ctx to resolve the session id.
const PLAN_SHAPE = `${PLAN_DIR}/<session_id>.md`;
// Judge toolset: strictly read-only, NO bash -- the judge can never execute or mutate anything, and
// in particular never re-runs a verify command (which may be a 10-hour training job). The agent runs
// verify itself and saves the output as evidence; the judge reads it. Names match pi's tool registry.
const JUDGE_TOOLS = ["read", "grep", "find", "ls"];
const JUDGE_BLOCKED_TOOLS = ["edit", "write"];
const JUDGE_TIMEOUT_MS = 600_000;
// Plan mode is read-only by convention AND a light gate: edit/write are blocked (except the plan
// file, the deliverable). bash stays open — the prompt says don't mutate; guide, not gate (spec D3).
const PLAN_MODE_BLOCKED_TOOLS = ["edit", "write"];
// Turns the plan may go untouched before it is re-sent. pi-tasks uses 4, or 2 while something is in
// progress; here every goal is "in progress", so 2.
const STALE_TURNS = 2;

// A checkbox line beginning "goal:", for the widget and the "any goals open?" reminder condition.
// Everything else reads the file as prose.
const GOAL_LINE = /^\s*(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*goal:\s*(.*)$/i;
// An indented checkbox line that isn't a goal: a subtask. Only the widget reads these, so the human
// sees the next action and not just the goal -- this file IS the task list.
const SUBTASK_LINE = /^\s+(?:\d+\.|[-*])\s*\[([ xX/-])\]\s*(.*)$/;
// The fold. Above it: the working set that gets re-sent. Below it: durable memory.
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

/** The working set: everything above "## Log". Log, Learnings and Appendix below it are durable
 *  memory -- unlimited, read on demand, pushed back only by a resync. Exported for the unit test. */
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

interface PlanState {
	isPlanMode: boolean;
	/** Optional model ref for the sign-off judge; unset => current session model, else pi's default. */
	judgeModel: string | null;
}

export default function piGoalsExtension(pi: ExtensionAPI): void {
	let state: PlanState = { isPlanMode: false, judgeModel: null };
	// Reminder cadence (pi-tasks style): the plan is re-sent only after it has gone untouched for
	// STALE_TURNS turns, and editing it resets the clock -- an agent that is maintaining the file
	// doesn't need to be told to. In-memory, like pi-tasks: a new session starts fresh.
	let turnsStale = 0;
	let lastSeenPlan = "";
	// Set on session start and after a compaction; drained by the next LLM call, which then carries
	// the WHOLE file (appendix included) instead of just the working set.
	let resyncReason: string | null = "New session.";

	const planRel = (ctx: ExtensionContext) => `${PLAN_DIR}/${ctx.sessionManager.getSessionId()}.md`;
	const planPath = (ctx: ExtensionContext) => join(ctx.cwd, planRel(ctx));
	const readPlan = (ctx: ExtensionContext): string => (existsSync(planPath(ctx)) ? readFileSync(planPath(ctx), "utf-8") : "");
	const writePlan = (ctx: ExtensionContext, content: string): void => {
		mkdirSync(join(ctx.cwd, PLAN_DIR), { recursive: true });
		writeFileSync(planPath(ctx), content);
	};

	function persist(): void {
		pi.appendEntry<PlanState>(STATE, state);
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (state.isPlanMode) {
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
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◷ ${done}/${goals.length} goals`));
		const mark: Record<GoalStatus, string> = { done: "✔", active: "▸", open: "◻", cancelled: "✗" };
		// Only live goals get lines so finished work never pushes current work off screen. The active
		// goal also shows its open subtasks: this file is the task list, so the widget is the task list.
		// No path line: the session id makes it 47 chars, too long to be worth a widget row. The
		// human opens the file from the Ready menu, and every injected reminder still names it.
		const plan = readPlan(ctx);
		const lines: string[] = [];
		for (const g of goals.filter((g) => g.status === "active" || g.status === "open")) {
			lines.push(`${mark[g.status]} ${g.subject}`);
			if (g.status === "active") lines.push(...openSubtasks(plan, g.line).slice(0, 3).map((s) => ctx.ui.theme.fg("muted", `   ◦ ${s}`)));
		}
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	// --- /goals: enter plan mode (or clear / set judge) --------------------------------------------

	pi.registerCommand("goals", {
		description: `Plan mode: draft goals into ${PLAN_SHAPE}, review, then work them. /goals <objective> | /goals clear | /goals judge <model>`,
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "clear") {
				rmSync(planPath(ctx), { force: true });
				state = { ...state, isPlanMode: false };
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`Deleted ${planRel(ctx)}.`, "info");
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

	/** What this LLM call should carry, if anything: a one-shot resync, or a staleness reminder. */
	function dueInjection(ctx: ExtensionContext, plan: string): string | null {
		const drainResync = (): string | null => {
			const why = resyncReason;
			resyncReason = null;
			return why;
		};
		if (state.isPlanMode) {
			const why = drainResync();
			return why ? `<system-reminder>\n${why} You are still in plan mode.\n\n${planDrafting}\n\nWrite the plan to ${planPath(ctx)}.\n</system-reminder>` : null;
		}
		if (!plan.trim()) return null;
		const why = drainResync();
		if (why) return resync(plan, planRel(ctx), why);
		if (turnsStale < STALE_TURNS) return null;
		const goals = scanGoals(plan);
		if (goals.length === 0) {
			// Non-empty plan but no recognizable goal line: the harness would go silently inert (no
			// widget, no injection, no reminders). Say so instead -- cooperative but confused.
			return `<system-reminder>\n${planRel(ctx)} exists but has no goal line pi-goals recognizes. A goal is a checkbox list line starting "goal:", e.g. "1. [ ] goal: <imperative>" ([ ] open, [/] active, [x] done, [-] cancelled). Reformat it if it's meant to be the plan.\n</system-reminder>`;
		}
		if (!goals.some((g) => g.status === "active" || g.status === "open")) return null;
		return reminder(foldPlan(plan), planRel(ctx));
	}

	// The one injection point: a transient user message on this LLM call only, never persisted. So
	// there are no stale copies to strip, and an untouched turn costs nothing.
	pi.on("context", async (event, ctx) => {
		const text = dueInjection(ctx, readPlan(ctx));
		if (!text) return;
		turnsStale = 0;
		return { messages: [...event.messages, { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() }] };
	});

	// The staleness clock: editing the plan resets it, the way a task tool call resets pi-tasks'.
	pi.on("turn_end", async (_event, ctx) => {
		const plan = readPlan(ctx);
		if (plan === lastSeenPlan) {
			turnsStale++;
			return;
		}
		lastSeenPlan = plan;
		turnsStale = 0;
		updateWidget(ctx);
	});

	// A compaction is exactly when the settled context is gone, so push the whole file back once.
	pi.on("session_compact", async () => {
		resyncReason = "The session was just compacted.";
	});

	// Plan mode gate: block edit/write except on the plan file itself. bash stays open (guide, not gate).
	pi.on("tool_call", async (event, ctx) => {
		if (!state.isPlanMode) return;
		if (PLAN_MODE_BLOCKED_TOOLS.includes(event.toolName)) {
			const target = (event.input as { path?: string }).path;
			if (target && resolve(ctx.cwd, target) === resolve(planPath(ctx))) return;
			return { block: true, reason: `Plan mode is read-only: only ${planRel(ctx)} may be written while drafting. Agree the goals first, then choose Ready.` };
		}
	});

	// After a plan-mode turn: if goals were drafted, print the working set and offer Ready. The plan
	// is printed because "Ready?" over an unread file is not a review: the only other copy is inside
	// a collapsed edit tool call. Reprinted after an $EDITOR pass only if the text changed.
	// The human then says go, edits it, or keeps talking to revise it (menu shape borrowed from pi-plan).
	pi.on("agent_end", async (_event, ctx) => {
		if (!state.isPlanMode || !ctx.hasUI) return;
		let printed = "";
		while (scanGoals(readPlan(ctx)).length > 0) {
			const working = foldPlan(readPlan(ctx));
			if (working !== printed) {
				printed = working;
				pi.sendMessage({ customType: "plan", content: working, display: true });
			}
			const choice = await ctx.ui.select(`Plan drafted in ${planRel(ctx)}. Ready?`, [
				"Ready — start working the plan",
				"Ready + compact — the same, but summarize the planning chatter away first",
				"Open in $EDITOR — edit it myself",
				"Keep planning (reply to revise)",
			]);
			if (choice?.startsWith("Open")) {
				spawnSync(process.env.EDITOR || process.env.VISUAL || "vi", [planPath(ctx)], { stdio: "inherit" });
				continue;
			}
			if (!choice?.startsWith("Ready")) return;
			state = { ...state, isPlanMode: false };
			persist();
			updateWidget(ctx);
			const work = `Work the goals in ${planPath(ctx)}. Pick an open goal, mark it active ([/]), work its subtasks, and when its discriminator is satisfied fill its evidence: list, then call CompleteGoal with the goal's text. Keep the plan file current as you go.`;
			if (!choice.includes("compact")) {
				pi.sendUserMessage(work, { deliverAs: "followUp" });
				return;
			}
			// Compaction fires session_compact, so the whole plan file comes back on the next call --
			// the exploration is summarized away, the agreed goals are not. Sent from onComplete so
			// the work turn starts after the summary exists; a failed compaction still starts work.
			ctx.compact({
				customInstructions: `Planning is finished. Keep what ${planRel(ctx)} depends on: the objective, the human's constraints, and what was ruled out and why. The read-only exploration that produced them can go.`,
				onComplete: () => pi.sendUserMessage(work, { deliverAs: "followUp" }),
				onError: (e) => {
					ctx.ui.notify(`Compaction failed (${e.message}); starting work anyway.`, "warning");
					pi.sendUserMessage(work, { deliverAs: "followUp" });
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
		if (last?.data) state = { ...state, ...last.data };
		lastSeenPlan = readPlan(ctx);
		resyncReason = "New session.";
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
			if (!plan.trim()) return result(`No plan file at ${planRel(ctx)}. Run /goals to draft one.`, true);

			const judgeModel = state.judgeModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
			onUpdate?.({ content: [{ type: "text", text: `Read-only judge (${judgeModel ?? "pi default"}) inspecting: ${params.goal}` }], details: {} });
			// decideSignOff runs the judge and derives the outcome + the one log line. judgeModel is never
			// checked pre-emptively: null just means pi's configured default runs (buildJudgeArgs omits
			// --model), so accepted_inconclusive always means "the judge ran but failed", never "no model".
			let judgeRaw: JudgeResult | null = null;
			const outcome = await decideSignOff({ goal: params.goal, plan, planRel: planRel(ctx), judgeModel }, signal, async (task) => {
				judgeRaw = await runJudge(task, judgeModel, ctx.cwd, signal);
				return judgeRaw;
			});
			// Persist the judge's full transcript so "did the judge really re-run verify?" is answerable
			// after the fact (dogfood finding: with only the one log line, an accept is unauditable).
			let transcriptNote = "";
			if (judgeRaw !== null) {
				const raw: JudgeResult = judgeRaw;
				mkdirSync(join(ctx.cwd, ".pi", "judge"), { recursive: true });
				const rel = `.pi/judge/${stamp().replace(/[: ]/g, "-")}.md`;
				writeFileSync(join(ctx.cwd, rel), `goal: ${params.goal}\nmodel: ${judgeModel ?? "pi default"}\nerror: ${raw.error ?? "none"}\n\n${raw.output}\n`);
				transcriptNote = ` (${rel})`;
			}
			if (outcome.logEntry) {
				// Sign-off write: tick the goal [x] (exact-subject match; dogfood showed agent bookkeeping
				// is the drift point) and append the audit log line, one write. On wording drift the tick
				// falls to the agent and the result says so -- both paths are explicit, never silent.
				let updated = readPlan(ctx);
				let tickNote = "";
				if (outcome.logEntry.startsWith("signed off")) {
					const ticked = tickGoal(updated, params.goal);
					updated = ticked ?? updated;
					tickNote = ticked
						? `\n\nGoal ticked [x] in ${planRel(ctx)}.`
						: `\n\nNo exact goal line matched your wording -- tick it [x] in ${planRel(ctx)} yourself.`;
				}
				writePlan(ctx, appendLog(updated, `${stamp()} ${outcome.logEntry}${transcriptNote}`));
				updateWidget(ctx);
				return result(outcome.resultText + tickNote, outcome.isError);
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
	/** The session's plan file, relative to cwd; the judge prompt names it. */
	planRel: string;
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
	const task = judgeUser({ goal: input.goal, plan: input.plan, planPath: input.planRel });
	const judge = await runJudgeFn(task);

	if (signal?.aborted) return { resultText: "Sign-off aborted.", isError: true, logEntry: null };

	// Judge ran but failed/errored/timed out: fail forward, say so in the log.
	if (judge.error) {
		const partial = judge.output ? `\n\npartial judge output:\n${judge.output}` : "";
		return {
			resultText: `Judge ran but failed (${judge.error}). Accepted inconclusive — logged.${partial}`,
			isError: false,
			logEntry: `signed off "${input.goal}" (judge inconclusive: ran but failed: ${oneLine(judge.error)})`,
		};
	}

	const verdictLine = judge.output.split("\n").find((l) => /^\s*VERDICT\s*:/i.test(l)) ?? "";
	const verdict = /^\s*VERDICT\s*:\s*(accept|reject)\s*$/i.exec(verdictLine)?.[1]?.toLowerCase();
	const reasoning = judge.output.length > 2000 ? `...\n${judge.output.slice(-2000)}` : judge.output;

	if (verdict === "accept") {
		return {
			resultText: `Sign-off ACCEPTED (log line appended).\n\n--- judge ---\n${reasoning}`,
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
		resultText: `Judge returned no VERDICT line. Accepted inconclusive — logged.\n\n--- judge ---\n${reasoning || "(no output)"}`,
		isError: false,
		logEntry: `signed off "${input.goal}" (judge inconclusive: no VERDICT line)`,
	};
}

/** Tick the goal line whose subject exactly matches `goal` (trimmed, case-insensitive) to [x].
 *  Null when there is no unique exact match (wording drift / duplicates) -- the caller then asks the
 *  agent to tick it itself. Reuses GOAL_LINE; deliberately NOT fuzzy, that's the judge's job. */
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
