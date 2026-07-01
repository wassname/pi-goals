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
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { counts, findGoal, type Goal, type PlanDoc, parse, pruneCompleted, recordSignOff, type SignOff } from "./plan-file.js";
import {
	completeGoalDescription,
	completeGoalParamDescription,
	evidenceJudgeSystem,
	evidenceJudgeUser,
	planDrafting,
	planInjection,
	reminder,
} from "./prompts.js";

const STATE = "pi-goals-state";
const PLAN_CONTEXT = "pi-goals-context"; // injected plan-mode guidance, stripped from history later
const STATUS_KEY = "pi-goals";
const WIDGET_KEY = "pi-goals-widget";
// Tools the sign-off judge gets: read-only inspection + bash (for git log, cat, running scripts to
// inspect). File mutators (edit, write) are blocked so the judge cannot modify anything.
// Names match pi's internal tool registry (grep→ffgrep, find→fffind, etc.).
const JUDGE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const JUDGE_BLOCKED_TOOLS = ["edit", "write"];
const JUDGE_TIMEOUT_MS = 600_000;
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
	/** Optional model ref for the sign-off judge; unset => use the current session model. */
	judgeModel: string | null;
}

export default function piGoalsExtension(pi: ExtensionAPI): void {
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
		ctx.ui.setWidget(WIDGET_KEY, goalWidgetLines(doc, ctx));
	}

	function goalWidgetLines(doc: PlanDoc, ctx: ExtensionContext): string[] {
		const mark: Record<Goal["status"], string> = { done: "✔", active: "▸", open: "◻", cancelled: "✗" };
		// Header doubles as the file path (clickable) so we don't spend a second line on a "Goals:" label
		// plus a footer path -- one line carries both. Title trails the path when set.
		const header = ctx.ui.theme.fg("muted", doc.title ? `${PLAN_REL}: ${doc.title}` : PLAN_REL);
		const lines = [header];
		// Only the live work (active + open) gets lines; finished goals (done/cancelled) are hidden so
		// they never push the current work off screen. The done count lives in the status bar (◷ n/N
		// goals) and the full history in goals.md / the ## Log.
		const live = doc.goals.filter((g) => g.status === "active" || g.status === "open");
		for (const g of live) {
			const total = g.subtasks.length;
			const done = g.subtasks.filter((s) => s.status === "done").length;
			lines.push(`${mark[g.status]} ${g.subject}${total ? ` (${done}/${total} tasks)` : ""}`);
		}
		return lines;
	}

	// --- plan mode: setup -------------------------------------------------------------------------

	pi.registerCommand("goals", {
		description: "Plan mode: set up goals (with evidence) in goals.md, then work them. /goals <objective> | /goals clear",
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
		ctx.ui.notify(ref ? `Sign-off judge model set to ${ref}` : "Sign-off judge reset to the current session model", "info");
	}

	async function clearPlan(ctx: ExtensionContext): Promise<void> {
		if (!existsSync(planPath(ctx))) {
			ctx.ui.notify("No goals.md to clear.", "info");
			return;
		}
		if (ctx.hasUI) {
			const choice = await ctx.ui.select(`Clear ${PLAN_REL}?`, [
				"Cancel",
				"Prune completed goals (keep active/open + log)",
				"Clear everything",
			]);
			if (!choice || choice.startsWith("Cancel")) return;
			if (choice.startsWith("Prune")) {
				writePlan(ctx, pruneCompleted(readPlan(ctx)));
				updateWidget(ctx);
				ctx.ui.notify(`Pruned completed goals from ${PLAN_REL}.`, "info");
				return;
			}
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
		label: "Goal signoff",
		description: completeGoalDescription,
		parameters: Type.Object({
			goal: Type.String({ description: completeGoalParamDescription }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const content = readPlan(ctx);
			const goal = findGoal(parse(content), params.goal);
			if (!goal) return text(`No goal "${params.goal}" in goals.md. Use the exact text after "goal:".`, true);
			if (goal.evidence.length === 0) {
				return text(`Goal "${goal.subject}" has no evidence yet. Add an evidence: list to the goal in goals.md (artifacts + a short read showing the discriminator is satisfied), then call CompleteGoal.`, true);
			}

			const handleUpdate = (partial: { content: Array<{ type: "text"; text: string }>; details: SignOffDetails }) => {
				onUpdate?.(partial);
			};

			const judgeModel = state.judgeModel ?? currentSessionModelRef(ctx);
			const { outcome, reasoning, durationMs } = await decideSignOff(goal, goal.evidence.join("\n"), goal.evidence, judgeModel, ctx.cwd, signal, handleUpdate);
			const res = recordSignOff(content, goal.subject, stamp(), outcome);
			if (res.content !== content) writePlan(ctx, res.content);
			updateWidget(ctx);
			const detail = reasoning ? `\n\n--- sign-off judge ---\n${reasoning}` : "";
			const outcomeLabel =
				outcome.kind === "accepted" ? "accepted" :
				outcome.kind === "accepted_inconclusive" ? "accepted_inconclusive" :
				outcome.kind === "verify_failed" ? "verify_failed" :
				"rejected";
			const details: SignOffDetails = {
				goal: goal.subject,
				outcome: outcomeLabel,
				durationMs,
				verifyCommand: goal.verify ?? undefined,
				verifyExitCode: outcome.kind === "verify_failed" ? outcome.exitCode : undefined,
				judgeModel: judgeModel ?? "no explicit judge model",
				reasoning,
				isError: res.isError,
			};
			return textWithDetails(res.message + detail, details, res.isError);
		},

		renderCall(args, theme) {
			const goalText = args.goal.length > 80 ? `${args.goal.slice(0, 80)}...` : args.goal;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("goal signoff "))}${theme.fg("dim", goalText)}`,
				0, 0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SignOffDetails | undefined;
			const body = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
			if (!details || details.outcome === "running") return new Text(body, 0, 0);

			const accepted = details.outcome === "accepted" || details.outcome === "accepted_inconclusive";
			const icon = accepted ? theme.fg("success", "✔") : theme.fg("error", "✗");
			const outcomeText =
				details.outcome === "accepted" ? "accepted" :
				details.outcome === "accepted_inconclusive" ? "accepted (judge inconclusive)" :
				details.outcome === "verify_failed" ? `verify failed (exit ${details.verifyExitCode})` :
				"rejected";
			const header = `${icon} ${theme.fg("toolTitle", theme.bold("goal signoff "))}${theme.fg("accent", outcomeText)}`;
			const duration = details.durationMs < 1000 ? `${details.durationMs}ms` : `${(details.durationMs / 1000).toFixed(1)}s`;
			const sub = [details.judgeModel, duration].filter(Boolean).join(" · ");

			if (!expanded) {
				let text = header;
				if (sub) text += `\n${theme.fg("dim", sub)}`;
				text += `\n\n${theme.fg("toolOutput", body.slice(0, 500))}`;
				if (body.length > 500) text += theme.fg("dim", "...");
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			if (sub) container.addChild(new Text(theme.fg("dim", sub), 0, 0));
			if (details.verifyCommand) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", `verify: ${details.verifyCommand}`), 0, 0));
			}
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Judge"), 0, 0));
			container.addChild(new Markdown(body.trim(), 0, 0, getMarkdownTheme()));
			return container;
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

/** Structured details returned by CompleteGoal so renderCall/renderResult can show metadata. */
interface SignOffDetails {
	goal: string;
	outcome: "accepted" | "accepted_inconclusive" | "rejected" | "verify_failed" | "running";
	phase?: string; // "verifying" | "spawning" | "judging" — while running
	durationMs: number;
	verifyCommand?: string;
	verifyExitCode?: number;
	judgeModel?: string;
	reasoning: string;
	isError?: boolean;
}

function text(s: string, isError = false) {
	return { content: [{ type: "text" as const, text: s }], details: { isError }, isError };
}

function textWithDetails(s: string, details: SignOffDetails, isError = false) {
	return { content: [{ type: "text" as const, text: s }], details, isError };
}

function stamp(): string {
	return new Date().toISOString().slice(0, 16).replace("T", " ");
}

function currentSessionModelRef(ctx: ExtensionContext): string | null {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
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
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: SignOffDetails }) => void,
): Promise<{ outcome: SignOff; reasoning: string; durationMs: number }> {
	const startedAt = Date.now();
	const emit = (phase: string, text: string) => {
		onUpdate?.({
			content: [{ type: "text" as const, text }],
			details: { goal: goal.subject, outcome: "running", phase, durationMs: Date.now() - startedAt, verifyCommand: goal.verify ?? undefined, judgeModel: judgeModel ?? undefined, reasoning: "" },
		});
	};
	let verifyResult: { command: string; exitCode: number; outputTail: string } | null = null;
	if (goal.verify) {
		emit("verifying", `Running verify: ${goal.verify}`);
		verifyResult = runVerify(goal.verify, cwd, signal);
		if (verifyResult.exitCode !== 0) {
			return {
				outcome: { kind: "verify_failed", exitCode: verifyResult.exitCode, outputTail: verifyResult.outputTail },
				reasoning: `verify \`${goal.verify}\` exited ${verifyResult.exitCode}:\n${verifyResult.outputTail}`,
				durationMs: Date.now() - startedAt,
			};
		}
	}
	if (!judgeModel) {
		const reason = "no explicit judge model available; set /goals judge <provider/model>";
		return {
			outcome: { kind: "accepted_inconclusive", reason },
			reasoning: `VERDICT: inconclusive\nreason: ${reason}`,
			durationMs: Date.now() - startedAt,
		};
	}
	const verdict = await runJudge(goal, evidence, paths, verifyResult, judgeModel, cwd, signal, onUpdate);
	const outcome: SignOff =
		verdict.kind === "accepted"
			? { kind: "accepted" }
			: verdict.kind === "inconclusive"
				? { kind: "accepted_inconclusive", reason: verdict.reason }
				: { kind: "rejected", missing: verdict.missing };
	return { outcome, reasoning: verdict.reasoning, durationMs: verdict.durationMs };
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

function extractTextFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const text = (part as { text?: string }).text;
			if (typeof text === "string" && text.trim()) parts.push(text);
		}
	}
	return parts.join("\n\n").trim();
}

type JudgeResult =
	| { kind: "accepted"; reasoning: string; durationMs: number }
	| { kind: "rejected"; missing: string; reasoning: string; durationMs: number }
	| { kind: "inconclusive"; reason: string; reasoning: string; durationMs: number };

/** Stage 2: a read-only pi subprocess inspects the evidence against the repo and returns a verdict. */
async function runJudge(
	goal: Goal,
	evidence: string,
	paths: string[],
	verifyResult: { command: string; exitCode: number; outputTail: string } | null,
	judgeModel: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: SignOffDetails }) => void,
): Promise<JudgeResult> {
	const startedAt = Date.now();
	const emit = (phase: string, text: string) => {
		onUpdate?.({
			content: [{ type: "text" as const, text }],
			details: { goal: goal.subject, outcome: "running", phase, durationMs: Date.now() - startedAt, verifyCommand: goal.verify ?? undefined, judgeModel: judgeModel ?? undefined, reasoning: "" },
		});
	};
	const task = evidenceJudgeUser({
		subject: goal.subject,
		discriminator: goal.discriminator,
		failure_modes: goal.failure_modes,
		verify: goal.verify ?? null,
		verifyResult,
		evidence,
		paths,
	});
	const args = ["--mode", "json", "-p", "--no-session", "--model", judgeModel, "--tools", JUDGE_TOOLS.join(","), "--exclude-tools", JUDGE_BLOCKED_TOOLS.join(","), "--append-system-prompt", evidenceJudgeSystem];
	args.push(task);

	emit("spawning", `Spawning read-only judge for: ${goal.subject}`);
	const inv = getPiInvocation(args);
	// FIXME(side-effect): pi -p --no-session clones the repo into the PARENT of cwd (so alongside
	// the working dir), leaving a stale directory. The judge should run in a temp dir or inside the
	// existing repo checkout so it doesn't pollute the user's workspace.
	const judge = await new Promise<{ output: string; error?: string; aborted?: boolean }>((resolve) => {
		let settled = false;
		let stdoutBuffer = "";
		let finalOutput = "";
		let currentText = "";
		let stderr = "";
		let lastStopReason: string | undefined;
		let lastErrorMessage: string | undefined;
		let lastProgressAt = 0;
		const partialOutput = (): string => [finalOutput, currentText, stderr.trim()].filter(Boolean).join("\n\n").trim();
		const emitProgress = (text: string, force = false) => {
			const now = Date.now();
			if (!force && now - lastProgressAt < 750) return;
			lastProgressAt = now;
			emit("judging", text);
		};
		const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], signal });
		if (!proc.stdout || !proc.stderr) throw new Error("judge subprocess stdio must be piped");
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				proc.kill();
				resolve({ output: partialOutput(), error: `judge timed out after ${JUDGE_TIMEOUT_MS / 1000}s` });
			}
		}, JUDGE_TIMEOUT_MS);

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_start" && event.message?.role === "assistant") {
				currentText = "";
				emitProgress("Judge is reading evidence...", true);
				return;
			}
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				currentText += event.assistantMessageEvent.delta ?? "";
				emitProgress(currentText || "Judge is reading evidence...");
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = extractTextFromContent(event.message.content) || currentText;
				if (text) finalOutput = text;
				currentText = "";
				lastStopReason = typeof event.message.stopReason === "string" ? event.message.stopReason : undefined;
				lastErrorMessage = typeof event.message.errorMessage === "string" ? event.message.errorMessage : undefined;
				emitProgress(finalOutput || "Judge finished without text.", true);
			}
		};

		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
			emitProgress(partialOutput() || "Judge subprocess wrote stderr.");
		});
		proc.on("close", (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				if (lastStopReason === "error" || lastStopReason === "aborted") {
					resolve({ output: finalOutput, error: lastErrorMessage || `judge model ${lastStopReason}`, aborted: signal?.aborted });
					return;
				}
				if ((code ?? 0) !== 0) {
					resolve({ output: finalOutput, error: stderr.trim() || finalOutput || `judge subprocess exited ${code ?? 1}` });
					return;
				}
				resolve({ output: finalOutput });
			}
		});
		proc.on("error", (e) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ output: "", error: `judge subprocess failed: ${e.message}`, aborted: signal?.aborted });
			}
		});
	});

	if (judge.error) {
		const partial = judge.output.trim();
		if (judge.aborted) {
			return {
				kind: "rejected",
				missing: judge.error,
				reasoning: `VERDICT: reject\nmissing: ${judge.error}`,
				durationMs: Date.now() - startedAt,
			};
		}
		return {
			kind: "inconclusive",
			reason: judge.error,
			reasoning: partial
				? `VERDICT: inconclusive\nreason: ${judge.error}\n\npartial judge output:\n${partial}`
				: `VERDICT: inconclusive\nreason: ${judge.error}`,
			durationMs: Date.now() - startedAt,
		};
	}

	const clean = judge.output.trim();
	const verdictLine = clean.split("\n").find((l) => /^\s*VERDICT\s*:/i.test(l)) ?? "";
	const verdictMatch = /^\s*VERDICT\s*:\s*(accept|reject)\s*$/i.exec(verdictLine);
	if (!verdictMatch) {
		return {
			kind: "inconclusive",
			reason: clean ? "judge returned no exact VERDICT line" : "judge finished without returning any text",
			reasoning: clean || "VERDICT: inconclusive\nreason: judge finished without returning any text",
			durationMs: Date.now() - startedAt,
		};
	}
	const missingMatch = clean.match(/missing\s*:\s*([\s\S]*)$/i);
	// The judge's own words (inspection + verdict), so CompleteGoal can show them. The verdict is at the
	// end, so keep the tail when it's long.
	const trimmed = clean.trim();
	const reasoning = trimmed.length > 1800 ? `...\n${trimmed.slice(-1800)}` : trimmed;
	if (verdictMatch[1].toLowerCase() === "accept") return { kind: "accepted", reasoning, durationMs: Date.now() - startedAt };

	const missing = missingMatch?.[1].trim() || clean.slice(-500) || "judge gave no reason";
	return { kind: "rejected", missing, reasoning, durationMs: Date.now() - startedAt };
}
