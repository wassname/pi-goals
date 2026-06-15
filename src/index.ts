/**
 * pi-plan — plan mode that sets up goals with evidence, tracked in one plan.md, signed off by a
 * read-only subagent check. A successor to pi-lgtm, kept deliberately small (≈ burneikis/pi-plan
 * plus the additions: goals + failure_modes + subtasks, a sign-off check, a widget, a reminder).
 *
 * Philosophy (spec D3): the form guides, it does not gate. The agent edits plan.md with its normal
 * Edit tool. The one blessed tool is CompleteGoal, which runs the sign-off check and records it. The
 * reminder + the injected plan + git/widget visibility carry the process; we trust the agent's
 * judgement rather than guarding it.
 *
 * Flow:
 *   /plan <objective> -> plan mode: agent explores, drafts goals into plan.md (planDrafting guides)
 *   agent_end          -> review menu (Ready / Edit / $EDITOR / Cancel); Ready offers compaction
 *   execution          -> each turn, inject the plan summary (survives compaction) + a reminder;
 *                         agent works goals, ticks subtasks, appends ## Log, calls CompleteGoal
 *   CompleteGoal       -> optional deterministic verify, then a read-only oracle judge -> accept
 *                         flips status:done + logs; reject returns what's missing
 *
 * All model-facing text lives in prompts.tsx, in flow order.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { counts, findGoal, type Goal, type PlanDoc, parse, recordSignOff, type SignOff } from "./plan-file.js";
import { evidenceJudgeSystem, evidenceJudgeUser, planDrafting, planInjection, reminder } from "./prompts.js";

const STATE = "pi-plan-state";
const PLAN_CONTEXT = "pi-plan-context"; // injected plan-mode guidance, stripped from history later
const STATUS_KEY = "pi-plan";
const WIDGET_KEY = "pi-plan-widget";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];

interface PlanState {
	isPlanMode: boolean;
	objective: string | null;
	/** Optional model ref for the sign-off judge; unset => the subprocess uses pi's default model. */
	judgeModel: string | null;
}

export default function piPlanExtension(pi: ExtensionAPI): void {
	let state: PlanState = { isPlanMode: false, objective: null, judgeModel: null };
	// Reminder cadence: fire when an active goal exists but plan.md was not touched since last turn.
	let lastInjectedPlan = "";
	// newSession is only on the command-handler context; agent_end's ctx lacks it. Save it from /plan.
	let savedCmdCtx: ExtensionCommandContext | null = null;

	const planPath = (ctx: ExtensionContext) => join(ctx.cwd, "plan.md");
	const readPlan = (ctx: ExtensionContext): string => (existsSync(planPath(ctx)) ? readFileSync(planPath(ctx), "utf-8") : "");

	function persist(): void {
		pi.appendEntry<PlanState>(STATE, state);
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (state.isPlanMode) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "planning"));
			ctx.ui.setWidget(WIDGET_KEY, ["pi-plan: drafting goals", "Write goals to plan.md, then review."]);
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
		ctx.ui.setWidget(WIDGET_KEY, goalWidgetLines(doc));
	}

	function goalWidgetLines(doc: PlanDoc): string[] {
		const mark: Record<Goal["status"], string> = { done: "✔", active: "▸", open: "◻", cancelled: "✗" };
		const lines = [`Plan: ${doc.objective || "(untitled)"}`];
		for (const g of doc.goals) {
			// Show every goal with its status glyph (✔ done, ▸ active, ◻ open, ✗ cancelled) so finished
			// goals read as checked off rather than vanishing. Plans are small, so this stays readable.
			const total = g.subtasks.length;
			const done = g.subtasks.filter((s) => s.done).length;
			lines.push(`${mark[g.status]} ${g.subject}${total ? ` (${done}/${total} tasks)` : ""}`);
		}
		return lines;
	}

	// --- plan mode: setup -------------------------------------------------------------------------

	pi.registerCommand("plan", {
		description: "Plan mode: set up goals (with evidence) in plan.md, then work them. /plan <objective>",
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
			// Bare `/plan` enters plan mode by prompting for the objective (the common expectation).
			// If the user cancels with no objective, fall back to showing the current plan.
			let objective = arg;
			if (!objective) {
				objective = (ctx.hasUI ? await ctx.ui.input("Plan mode — what's the objective?", "Describe what you want to plan") : undefined)?.trim() ?? "";
				if (!objective) {
					showPlan(ctx);
					return;
				}
			}

			state = { ...state, isPlanMode: true, objective };
			persist();
			updateWidget(ctx);
			pi.sendUserMessage(
				`Enter plan mode for this objective: ${objective}\n\nExplore read-only, then write the plan to ${planPath(ctx)}.`,
				{ deliverAs: "followUp" },
			);
		},
	});

	function setJudge(ref: string, ctx: ExtensionContext): void {
		state = { ...state, judgeModel: ref || null };
		persist();
		ctx.ui.notify(ref ? `Sign-off judge model set to ${ref}` : "Sign-off judge reset to the default model", "info");
	}

	async function clearPlan(ctx: ExtensionContext): Promise<void> {
		if (!existsSync(planPath(ctx))) {
			ctx.ui.notify("No plan.md to clear.", "info");
			return;
		}
		if (ctx.hasUI) {
			const ok = await ctx.ui.select("Clear plan.md? (it stays in git history)", ["Cancel", "Clear plan.md"]);
			if (ok !== "Clear plan.md") return;
		}
		writeFileSync(planPath(ctx), "");
		state = { ...state, isPlanMode: false, objective: null };
		persist();
		updateWidget(ctx);
		ctx.ui.notify("Cleared plan.md.", "info");
	}

	function showPlan(ctx: ExtensionContext): void {
		const content = readPlan(ctx);
		if (!content.trim()) {
			ctx.ui.notify("No plan yet. Use /plan <objective> to start.", "info");
			return;
		}
		ctx.ui.notify(content, "info");
	}

	// --- review loop (after the agent drafts the plan) --------------------------------------------

	async function reviewLoop(ctx: ExtensionContext): Promise<void> {
		while (true) {
			const doc = parse(readPlan(ctx));
			const choice = await ctx.ui.select(`Plan: ${doc.goals.length} goal(s). What next?`, [
				"Ready — start working the plan",
				"Edit — ask the agent to revise",
				"Open in $EDITOR",
				"Cancel — leave plan mode",
			]);
			if (!choice || choice.startsWith("Cancel")) {
				exitPlanMode(ctx);
				ctx.ui.notify("Left plan mode. plan.md kept.", "info");
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
		const startMsg = `Work the plan in ${planFile}. Pick an open goal, mark it active (set its header to [/]), work its subtasks, and when its done_when is met fill the goal's evidence: block then call CompleteGoal with the goal_id. Keep plan.md current as you go.`;
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
		if (doc.objective) pi.setSessionName(`Plan: ${doc.objective}`);
		ctx.ui.notify(planContent, "info");
		pi.sendUserMessage(startMsg, { deliverAs: "followUp" });
	}

	// --- the one blessed tool: CompleteGoal -------------------------------------------------------

	pi.registerTool({
		name: "CompleteGoal",
		label: "Complete goal",
		description:
			"Sign off a goal once its done_when is met. First fill the goal's evidence: block in plan.md " +
			"(a '- ' list pointing at durable artifacts: saved logs, committed diffs, files, not claims), then " +
			"call this with the goal_id. Runs the goal's verify command (if any) then a read-only subagent that " +
			"inspects that evidence against the repo. On accept, the goal is marked done and logged; on reject, " +
			"it stays open and you get what is missing.",
		parameters: Type.Object({
			goal_id: Type.String({ description: "The goal's <!-- id --> from plan.md" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const content = readPlan(ctx);
			const goal = findGoal(parse(content), params.goal_id);
			if (!goal) return text(`No goal #${params.goal_id} in plan.md.`, true);
			if (goal.evidence.length === 0) {
				return text(`Goal #${goal.id} has no evidence: block. Add a "- " evidence list to the goal in plan.md (what shows done_when is met, and where to verify it), then call CompleteGoal.`, true);
			}

			// Decide the outcome (the I/O); recordSignOff applies it to the file (the pure write).
			// Evidence and the artifacts to inspect both come from the goal's evidence: block (single source of truth).
			const outcome = await decideSignOff(goal, goal.evidence.join("\n"), goal.evidence, state.judgeModel, ctx.cwd, signal);
			const res = recordSignOff(content, goal.id, stamp(), outcome);
			if (res.content !== content) writeFileSync(planPath(ctx), res.content);
			updateWidget(ctx);
			return text(res.message, res.isError);
		},
	});

	// --- hooks ------------------------------------------------------------------------------------

	pi.on("before_agent_start", async (_event, ctx) => {
		if (state.isPlanMode) {
			return { message: { customType: PLAN_CONTEXT, content: `${planDrafting}\n\nWrite the plan to ${planPath(ctx)}.`, display: false } };
		}
		const doc = parse(readPlan(ctx));
		if (doc.goals.length === 0) return;

		const active = doc.goals.find((g) => g.status === "active") ?? doc.goals.find((g) => g.status === "open") ?? null;
		const c = counts(doc);
		let body = planInjection({
			objective: doc.objective,
			activeGoal: active
				? { subject: active.subject, done_when: active.done_when, openSubtasks: active.subtasks.filter((s) => !s.done).map((s) => s.text) }
				: null,
			lastLogLine: doc.log.at(-1) ?? null,
			counts: { done: c.done, open: c.open + c.active },
		});
		// Reminder fires when there is an active goal but plan.md was untouched since the last turn.
		const planNow = readPlan(ctx);
		if (active && planNow === lastInjectedPlan) body += `\n\n${reminder}`;
		lastInjectedPlan = planNow;
		return { message: { customType: PLAN_CONTEXT, content: body, display: false } };
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.isPlanMode || !ctx.hasUI) return;
		const doc = parse(readPlan(ctx));
		if (doc.goals.length === 0) {
			ctx.ui.notify("No goals found in plan.md yet — ask the agent to draft them.", "warning");
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

/** Decide a sign-off: deterministic verify first (cheap; skip the model call if it fails), then the judge. */
async function decideSignOff(
	goal: Goal,
	evidence: string,
	paths: string[],
	judgeModel: string | null,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<SignOff> {
	let verifyResult: { command: string; exitCode: number; outputTail: string } | null = null;
	if (goal.verify) {
		verifyResult = runVerify(goal.verify, cwd, signal);
		if (verifyResult.exitCode !== 0) {
			return { kind: "verify_failed", exitCode: verifyResult.exitCode, outputTail: verifyResult.outputTail };
		}
	}
	const verdict = await runJudge(goal, evidence, paths, verifyResult, judgeModel, cwd, signal);
	return verdict.accept ? { kind: "accepted" } : { kind: "rejected", missing: verdict.missing };
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
): Promise<{ accept: boolean; missing: string }> {
	const task = evidenceJudgeUser({
		subject: goal.subject,
		done_when: goal.done_when,
		verify: goal.verify ?? null,
		verifyResult,
		failure_modes: goal.failure_modes,
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
	return { accept, missing };
}
