/**
 * pi-goals — plan mode that sets up goals with evidence, tracked in one .pi/goals.md, signed off by a
 * read-only subagent check. A successor to pi-lgtm, kept deliberately small (≈ burneikis/pi-plan
 * plus the additions: goals + a discriminator + a subtle failure mode + subtasks, a sign-off check,
 * a widget, a reminder). A goal's success test is its discriminator: the observation that tells real
 * success from the named failure mode.
 *
 * Philosophy (spec D3): the form guides, it does not gate. The agent edits goals.md with its normal
 * Edit tool. The one blessed tool is CompleteGoal, which runs the sign-off check and records it. The
 * reminder + the injected plan + git/widget visibility carry the process; we trust the agent's
 * judgement rather than guarding it.
 *
 * Flow:
 *   /goals [objective] -> plan mode (conversational): objective is an optional seed; agent explores
 *                         read-only, asks, then drafts goals into .pi/goals.md (planDrafting guides)
 *   agent_end          -> review menu (Ready / Edit / $EDITOR / Cancel); Ready offers compaction
 *   execution          -> each turn, inject the plan summary (survives compaction) + a reminder;
 *                         agent works goals, ticks subtasks, appends ## Log, calls CompleteGoal
 *   CompleteGoal       -> optional deterministic verify, then a read-only oracle judge -> accept
 *                         flips status:done + logs; reject returns what's missing
 *
 * The plan file lives at <cwd>/.pi/goals.md (project-local, gitignored, like pi-tasks), not in the
 * repo. A fresh /goals draft just replaces it (the "overwrite" staleness rule).
 *
 * Plan mode is read-only: the tool_call hook blocks edit/write (except goals.md itself) and mutating
 * bash while drafting, so code isn't written before the goals are agreed. Read-only bash exploration
 * stays open (blocklist, not allowlist).
 *
 * Not built (FIXME): no plan-vs-exec model switch on accept (plan-model stickiness); noted at its
 * call site below.
 *
 * All model-facing text lives in prompts.ts, in flow order.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { counts, findGoal, type Goal, type PlanDoc, parse, recordSignOff, type SignOff } from "./plan-file.js";
import { evidenceJudgeSystem, evidenceJudgeUser, planDrafting, planInjection, reminder } from "./prompts.js";

const STATE = "pi-goals-state";
const PLAN_CONTEXT = "pi-goals-context"; // injected plan-mode guidance, stripped from history later
const STATUS_KEY = "pi-goals";
const WIDGET_KEY = "pi-goals-widget";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
// File mutators blocked while drafting goals (read-only plan mode, like narumiruna/pi-plan-mode), so
// code isn't written before goals are agreed. The one allowed write is goals.md itself (the
// deliverable). A read-only task (a pure search) can still be explored in plan mode by nature.
const PLAN_MODE_BLOCKED_TOOLS = ["edit", "write"];
// bash is dual-use, so block it only when the command looks mutating; read-only exploration (cat, rg,
// git log, running a script to inspect) stays open. Blocklist, not allowlist: keep exploration
// frictionless and just stop the obvious mutators. List adapted from narumiruna/pi-plan-mode; the
// redirect rule catches `> file` / `>> file` / `>| file` but not fd-dups like `2>&1` or `>&2`.
const MUTATING_BASH_PATTERNS: RegExp[] = [
	/\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd)\b/i,
	/>\s*[^&\s]/, // redirect to a file (write/append/clobber), excludes 2>&1 and >&2
	/\bnpm\s+(install|uninstall|update|ci|link|publish|version)\b/i,
	/\byarn\s+(add|remove|install|publish|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|publish|update)\b/i,
	/\bbun\s+(add|remove|install|update|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\buv\s+(add|remove|sync|lock|pip\s+install)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\b(sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];
const PLAN_REL = ".pi/goals.md"; // project-local, gitignored (pi-tasks convention); shown in the widget

interface PlanState {
	isPlanMode: boolean;
	objective: string | null;
	/** Optional model ref for the sign-off judge; unset => the subprocess uses pi's default model. */
	judgeModel: string | null;
}

export default function piPlanExtension(pi: ExtensionAPI): void {
	let state: PlanState = { isPlanMode: false, objective: null, judgeModel: null };
	// Reminder cadence: fire when an active goal exists but goals.md was not touched since last turn.
	let lastInjectedPlan = "";
	// newSession is only on the command-handler context; agent_end's ctx lacks it. Save it from /goals.
	let savedCmdCtx: ExtensionCommandContext | null = null;

	const planPath = (ctx: ExtensionContext) => join(ctx.cwd, ".pi", "goals.md");
	const readPlan = (ctx: ExtensionContext): string => (existsSync(planPath(ctx)) ? readFileSync(planPath(ctx), "utf-8") : "");
	// Our programmatic writes (clear, CompleteGoal). The agent creates/edits the file with its own Edit
	// tool; this just makes sure .pi/ exists for our writes.
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
			ctx.ui.setWidget(WIDGET_KEY, ["pi-goals: drafting goals", `Write goals to ${PLAN_REL}, then review.`]);
			return;
		}
		const doc = parse(readPlan(ctx));
		if (doc.goals.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const c = counts(doc);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◷ ${c.done}/${doc.goals.length} goals`));
		ctx.ui.setWidget(WIDGET_KEY, [...goalWidgetLines(doc), ctx.ui.theme.fg("muted", PLAN_REL)]);
	}

	function goalWidgetLines(doc: PlanDoc): string[] {
		const mark: Record<Goal["status"], string> = { done: "✔", active: "▸", open: "◻", cancelled: "✗" };
		const lines = [`Goals: ${doc.title || "(untitled)"}`];
		for (const g of doc.goals) {
			// Show every goal with its status glyph (✔ done, ▸ active, ◻ open, ✗ cancelled) so finished
			// goals read as checked off rather than vanishing. Plans are small, so this stays readable.
			const total = g.subtasks.length;
			const done = g.subtasks.filter((s) => s.status === "done").length;
			lines.push(`${mark[g.status]} ${g.subject}${total ? ` (${done}/${total} tasks)` : ""}`);
		}
		return lines;
	}

	// --- plan mode: setup -------------------------------------------------------------------------

	pi.registerCommand("goals", {
		description: "Plan mode: set up goals (with evidence) in goals.md, then work them. /goals <objective>",
		handler: async (args, ctx) => {
			savedCmdCtx = ctx; // ctx here is an ExtensionCommandContext (has newSession); keep it for later
			const arg = args.trim();
			if (arg === "clear") {
				await clearPlan(ctx);
				return;
			}
			if (arg.startsWith("judge")) {
				setJudge(arg.slice("judge".length).trim(), ctx);
				return;
			}
			// Conversational entry (like narumiruna/pi-plan-mode): /goals enters plan mode and starts a
			// dialogue. The objective is an optional seed, not a required arg, so there's no awkward
			// "type your objective" prompt; the agent explores read-only and asks before drafting. A
			// fresh draft just replaces .pi/goals.md (the "overwrite" staleness rule).
			const objective = arg || null;
			state = { ...state, isPlanMode: true, objective };
			persist();
			updateWidget(ctx);
			const seed = objective
				? `We're in plan mode. Objective: ${objective}\n\nExplore the repo read-only and ask me anything unclear. When the objective is nailed down, draft (or replace) the goals in ${planPath(ctx)}, then stop for review.`
				: `We're in plan mode. Tell me what you want to plan. Explore read-only and ask questions as needed; when the objective is clear, draft the goals in ${planPath(ctx)} and stop for review.`;
			pi.sendUserMessage(seed, { deliverAs: "followUp" });
		},
	});

	function setJudge(ref: string, ctx: ExtensionContext): void {
		state = { ...state, judgeModel: ref || null };
		persist();
		ctx.ui.notify(ref ? `Sign-off judge model set to ${ref}` : "Sign-off judge reset to the default model", "info");
	}

	async function clearPlan(ctx: ExtensionContext): Promise<void> {
		if (!existsSync(planPath(ctx))) {
			ctx.ui.notify("No goals.md to clear.", "info");
			return;
		}
		if (ctx.hasUI) {
			const ok = await ctx.ui.select(`Clear ${PLAN_REL}?`, ["Cancel", "Clear goals.md"]);
			if (ok !== "Clear goals.md") return;
		}
		writePlan(ctx, "");
		state = { ...state, isPlanMode: false, objective: null };
		persist();
		updateWidget(ctx);
		ctx.ui.notify(`Cleared ${PLAN_REL}.`, "info");
	}

	// --- review loop (after the agent drafts the plan) --------------------------------------------

	async function reviewLoop(ctx: ExtensionContext): Promise<void> {
		while (true) {
			const doc = parse(readPlan(ctx));
			const choice = await ctx.ui.select(`Goals: ${doc.goals.length} goal(s). What next?`, [
				"Ready — start working the plan",
				"Edit — ask the agent to revise",
				"Open in $EDITOR",
				"Cancel — leave plan mode",
			]);
			if (!choice || choice.startsWith("Cancel")) {
				exitPlanMode(ctx);
				ctx.ui.notify("Left plan mode. goals.md kept.", "info");
				return;
			}
			if (choice.startsWith("Ready")) return startExecution(ctx);
			if (choice.startsWith("Edit")) {
				const changes = await ctx.ui.editor("What should change about the plan?", "");
				if (changes?.trim()) {
					pi.sendUserMessage(`Revise the plan at ${planPath(ctx)} with these changes, same format:\n\n${changes.trim()}`, { deliverAs: "followUp" });
					return; // agent_end re-opens the review loop
				}
				continue;
			}
			if (choice.startsWith("Open")) {
				const editor = process.env.EDITOR || process.env.VISUAL || "vi";
				spawnSync(editor, [planPath(ctx)], { stdio: "inherit" });
			}
		}
	}

	function exitPlanMode(ctx: ExtensionContext): void {
		state = { ...state, isPlanMode: false };
		persist();
		updateWidget(ctx);
	}

	async function startExecution(ctx: ExtensionContext): Promise<void> {
		// FIXME(model-switch): the plan phase should be able to run on a sticky plan model and execution
		// on a different one (see README "Not yet included"). newSession can't switch the model yet; wire
		// this when pi exposes a model override on newSession.
		// Offer a clean execution context (D13). newSession lives only on the saved command context.
		let fresh = false;
		if (ctx.hasUI && savedCmdCtx) {
			const choice = await ctx.ui.select("Start working the plan in...", [
				"This context (keep history)",
				"A fresh, compacted context",
			]);
			fresh = choice?.startsWith("A fresh") ?? false;
		}
		const doc = parse(readPlan(ctx));
		const planFile = planPath(ctx);
		const planContent = readPlan(ctx); // captured now: ctx is stale after newSession below
		const parentSession = ctx.sessionManager.getSessionFile();
		const startMsg = `Work the goals in ${planFile}. Pick an open goal, mark it active (set its checkbox to [/]), work its subtasks, and when its discriminator is satisfied fill the goal's evidence: block then call CompleteGoal with the goal's desc. Keep goals.md current as you go.`;
		exitPlanMode(ctx);

		if (fresh && savedCmdCtx) {
			// After newSession, `ctx`/`pi` bound to the old session are stale; do post-swap work
			// through the ReplacedSessionContext passed to withSession (see runner.assertActive).
			const result = await savedCmdCtx.newSession({
				parentSession,
				withSession: async (sessionCtx) => {
					// pi.* and the outer ctx are invalidated by newSession; use the fresh sessionCtx only.
					// (No setSessionName here: it lives on pi/the outer ctx, both stale now. Cosmetic, skip it.)
					sessionCtx.ui.notify(planContent, "info");
					await sessionCtx.sendUserMessage(startMsg, { deliverAs: "followUp" });
				},
			});
			if (result.cancelled) {
				return;
			}
			return;
		}
		if (doc.title) pi.setSessionName(`Goals: ${doc.title}`);
		ctx.ui.notify(planContent, "info");
		pi.sendUserMessage(startMsg, { deliverAs: "followUp" });
	}

	// --- the one blessed tool: CompleteGoal -------------------------------------------------------

	pi.registerTool({
		name: "CompleteGoal",
		label: "Complete goal",
		description:
			"Sign off a goal once its discriminator is satisfied. First fill the goal's evidence: block in " +
			"goals.md: a list where each item pairs a durable artifact with a short read of it (a quoted+linked " +
			"log, a table plus how to read it, or a metric plus what it shows; quote the key lines and link the " +
			"rest, not a pasted blob or a bare claim). Then call this with the goal's desc (the text after " +
			"'goal:'). Runs the goal's verify command (if any) then a read-only subagent that inspects that " +
			"evidence against the repo and the discriminator. On accept, the goal is marked done and logged; on " +
			"reject, it stays open and you get what is missing. The subagent's reasoning is returned either way.",
		parameters: Type.Object({
			goal: Type.String({ description: "The goal's desc: the exact text after 'goal:' in its line." }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const content = readPlan(ctx);
			const goal = findGoal(parse(content), params.goal);
			if (!goal) return text(`No goal "${params.goal}" in goals.md. Use the exact text after "goal:".`, true);
			if (goal.evidence.length === 0) {
				return text(`Goal "${goal.subject}" has no evidence yet. Add an evidence: list to the goal in goals.md (artifacts + a short read showing the discriminator is satisfied), then call CompleteGoal.`, true);
			}

			// Decide the outcome (the I/O); recordSignOff applies it to the file (the pure write).
			// Evidence and the artifacts to inspect both come from the goal's evidence: block (single source of truth).
			const { outcome, reasoning } = await decideSignOff(goal, goal.evidence.join("\n"), goal.evidence, state.judgeModel, ctx.cwd, signal);
			const res = recordSignOff(content, goal.subject, stamp(), outcome);
			if (res.content !== content) writePlan(ctx, res.content);
			updateWidget(ctx);
			// Surface the sign-off judge's actual reasoning, not just the verdict, so it's visible (was a gap).
			const detail = reasoning ? `\n\n--- sign-off judge ---\n${reasoning}` : "";
			return text(res.message + detail, res.isError);
		},
	});

	// --- hooks ------------------------------------------------------------------------------------

	pi.on("before_agent_start", async (_event, ctx) => {
		if (state.isPlanMode) {
			// Read-only is enforced in the tool_call hook below (blocks edit/write while planning).
			return { message: { customType: PLAN_CONTEXT, content: `${planDrafting}\n\nWrite the plan to ${planPath(ctx)}.`, display: false } };
		}
		const doc = parse(readPlan(ctx));
		if (doc.goals.length === 0) return;

		const active = doc.goals.find((g) => g.status === "active") ?? doc.goals.find((g) => g.status === "open") ?? null;
		const c = counts(doc);
		let body = planInjection({
			title: doc.title,
			activeGoal: active
				? {
						subject: active.subject,
						discriminator: active.discriminator,
						openSubtasks: active.subtasks.filter((s) => s.status !== "done" && s.status !== "cancelled").map((s) => s.text),
					}
				: null,
			lastLogLine: doc.log.at(-1) ?? null,
			counts: { done: c.done, open: c.open + c.active },
		});
		// Reminder fires when there is an active goal but goals.md was untouched since the last turn.
		const planNow = readPlan(ctx);
		if (active && planNow === lastInjectedPlan) body += `\n\n${reminder}`;
		lastInjectedPlan = planNow;
		return { message: { customType: PLAN_CONTEXT, content: body, display: false } };
	});

	// Enforce read-only planning: block file mutators while in plan mode so code isn't written before
	// the goals are agreed. The agent draws back to read/grep/find/ls and read-only bash to explore.
	pi.on("tool_call", async (event, ctx) => {
		if (!state.isPlanMode) return;
		// edit/write: blocked, except writing goals.md itself (the deliverable of plan mode).
		if (PLAN_MODE_BLOCKED_TOOLS.includes(event.toolName)) {
			const target = (event.input as { path?: string }).path;
			if (target && resolve(ctx.cwd, target) === resolve(planPath(ctx))) return;
			return { block: true, reason: `Plan mode is read-only: agree the goals in ${PLAN_REL} and choose Ready before writing code (${event.toolName} is blocked while planning; only ${PLAN_REL} may be written).` };
		}
		// bash: blocked only when the command looks mutating; read-only exploration stays open.
		if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command ?? "";
			if (MUTATING_BASH_PATTERNS.some((re) => re.test(command))) {
				return { block: true, reason: `Plan mode is read-only: this bash command looks like it mutates state, so it's blocked while planning. Explore read-only, agree the goals in ${PLAN_REL}, then choose Ready.\nCommand: ${command}` };
			}
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.isPlanMode || !ctx.hasUI) return;
		const doc = parse(readPlan(ctx));
		if (doc.goals.length === 0) {
			ctx.ui.notify("No goals found in goals.md yet — ask the agent to draft them.", "warning");
			return;
		}
		await reviewLoop(ctx);
	});

	// Keep only the freshest injected plan summary; strip stale ones so history does not bloat and
	// the model never sees an out-of-date plan. (The current turn's injection is the one kept.)
	pi.on("context", async (event) => {
		const isCtx = (m: unknown) => (m as { customType?: string }).customType === PLAN_CONTEXT;
		let lastIdx = -1;
		event.messages.forEach((m, i) => {
			if (isCtx(m)) lastIdx = i;
		});
		return { messages: event.messages.filter((m, i) => !isCtx(m) || i === lastIdx) };
	});

	pi.on("session_start", async (_event, ctx) => {
		const last = ctx.sessionManager
			.getEntries()
			.filter((e: { type?: string; customType?: string }) => e.type === "custom" && e.customType === STATE)
			.pop() as { data?: PlanState } | undefined;
		if (last?.data) state = { ...state, ...last.data };
		updateWidget(ctx);
	});
}

// --- helpers (module scope; pure enough to keep out of the closure) -------------------------------

function text(s: string, isError = false) {
	return { content: [{ type: "text" as const, text: s }], details: { isError }, isError };
}

function stamp(): string {
	return new Date().toISOString().slice(0, 16).replace("T", " ");
}

/** Decide a sign-off: deterministic verify first (cheap; skip the model call if it fails), then the judge.
 *  Returns the outcome plus the judge's (or verify's) reasoning so CompleteGoal can show WHY. */
async function decideSignOff(
	goal: Goal,
	evidence: string,
	paths: string[],
	judgeModel: string | null,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{ outcome: SignOff; reasoning: string }> {
	let verifyResult: { command: string; exitCode: number; outputTail: string } | null = null;
	if (goal.verify) {
		verifyResult = runVerify(goal.verify, cwd, signal);
		if (verifyResult.exitCode !== 0) {
			return {
				outcome: { kind: "verify_failed", exitCode: verifyResult.exitCode, outputTail: verifyResult.outputTail },
				reasoning: `verify \`${goal.verify}\` exited ${verifyResult.exitCode}:\n${verifyResult.outputTail}`,
			};
		}
	}
	const verdict = await runJudge(goal, evidence, paths, verifyResult, judgeModel, cwd, signal);
	const outcome: SignOff = verdict.accept ? { kind: "accepted" } : { kind: "rejected", missing: verdict.missing };
	return { outcome, reasoning: verdict.reasoning };
}

/** Run the goal's verify command. It is agent-authored and trusted (single-user machine, guide-not-guard). */
function runVerify(command: string, cwd: string, signal: AbortSignal | undefined): { command: string; exitCode: number; outputTail: string } {
	const res = spawnSync("sh", ["-c", command], { cwd, encoding: "utf-8", signal, timeout: 600_000 });
	const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
	return { command, exitCode: res.status ?? 1, outputTail: out.split("\n").slice(-30).join("\n") };
}

/** Locate the pi binary the same way the oracle extension does, so spawning works under bun or node. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** Stage 2: a read-only pi subprocess inspects the evidence against the repo and returns a verdict. */
async function runJudge(
	goal: Goal,
	evidence: string,
	paths: string[],
	verifyResult: { command: string; exitCode: number; outputTail: string } | null,
	judgeModel: string | null,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{ accept: boolean; missing: string; reasoning: string }> {
	const task = evidenceJudgeUser({
		subject: goal.subject,
		discriminator: goal.discriminator,
		failure_modes: goal.failure_modes,
		verify: goal.verify ?? null,
		verifyResult,
		evidence,
		paths,
	});
	const args = ["-p", "--no-session", "--tools", READ_ONLY_TOOLS.join(","), "--append-system-prompt", evidenceJudgeSystem];
	if (judgeModel) args.push("--model", judgeModel);
	args.push(task);

	const inv = getPiInvocation(args);
	const output = await new Promise<string>((resolve) => {
		const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], signal });
		let out = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (out += d));
		proc.on("close", () => resolve(out));
		proc.on("error", (e) => resolve(`VERDICT: reject\nmissing: judge subprocess failed: ${e.message}`));
	});

	// The subprocess emits ANSI/CSI control codes in -p mode; strip them so they don't leak into `missing`.
	const clean = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

	const verdictLine = clean.split("\n").find((l) => /^\s*VERDICT\s*:/i.test(l)) ?? "";
	const accept = /accept/i.test(verdictLine);
	const missingMatch = clean.match(/missing\s*:\s*([\s\S]*)$/i);
	const missing = accept ? "" : (missingMatch?.[1].trim() || clean.trim().slice(-500) || "judge gave no reason");
	// The judge's own words (inspection + verdict), so CompleteGoal can show them. The verdict is at the
	// end, so keep the tail when it's long.
	const trimmed = clean.trim();
	const reasoning = trimmed.length > 1800 ? `...\n${trimmed.slice(-1800)}` : trimmed;
	return { accept, missing, reasoning };
}
