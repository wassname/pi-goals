/**
 * pi-goals v2 — all model-facing text, in flow order.
 *
 * Design: plan.md is for LLMs and the human, not for TypeScript. There is no parser and no schema;
 * the skeleton below is a convention the drafting prompt teaches, the working agent maintains with
 * its normal Edit tool, and the judge reads natively. The harness does three things for a
 * cooperative-but-confused model: memory (inject the file verbatim every turn), format guidance
 * (the skeleton), and fresh eyes (the read-only judge in CompleteGoal).
 *
 * Flow:
 *   SETUP (plan mode)     1. planDrafting   — draft goals into plan.md (read-only phase)
 *   EXEC, each turn start 2. (the plan.md file itself, injected verbatim by index.ts)
 *   EXEC, periodic        3. reminder       — upkeep + autonomy nudge when plan.md went untouched
 *   SIGN-OFF, agent-side  4. completeGoal*  — the one blessed tool's description
 *   SIGN-OFF, judge-side  5. judgeSystem/judgeUser — the one rigorous check
 *
 * The goal's test is the DISCRIMINATOR: the concrete observation that tells real success from the
 * named subtle failure mode. Evidence is empty at planning and filled at sign-off.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * 1. planDrafting — SETUP, plan mode (read-only: edit/write blocked except plan.md)
 * ──────────────────────────────────────────────────────────────────────── */
export const planDrafting = `\
You are in plan mode. The objective may arrive through conversation, not as one up-front command.
Explore the repository read-only first: resolve discoverable facts by looking them up, and only ask
the human when the answer is a genuine intent or preference choice. Do not write or run code in this
phase (edit/write are blocked except for the plan file; don't mutate state via bash either). When
the objective is clear, draft the plan file and stop for review.

Right-size it:
- Default to ONE goal. Add another only when it's a genuinely separate checkpoint that can pass or
  fail on its own. Most objectives are 1-2 goals.
- Subtasks are the steps inside a goal; add them when a goal has 3+ distinct steps, skip otherwise.
- Don't invent goals to look thorough. When in doubt, merge.

Write the plan file in roughly this shape (it's a convention, not a schema -- the file is read
directly by the human and a judge model, so clarity beats conformance; small deviations are fine):

# <short plan title>

<context: restate the user's ask, their stated preferences, and any decisions you've agreed on>

## Goals

1. [ ] goal: <one short imperative line>
  - subtle failure mode: <a way this could look done but isn't>
  - discriminator: <the concrete observation that tells real success from that failure>
  - verify: <optional shell command that exits 0 only when the discriminator passes; omit if not testable>
  - tasks:
    1. [ ] <subtask>
  - evidence: (empty until sign-off)

# Future work / out of scope

## Log

Conventions:
- A goal is a checkbox line beginning "goal:". Checkbox state: [ ] open, [/] active, [x] done,
  [-] cancelled. Leave goals [ ] at planning.
- subtle failure mode + discriminator are the heart of this. Name the ways a "done" could look
  achieved but not be (empty output, a silently-errored step, a gamed test, a no-op that dodged
  every trap and showed nothing). The discriminator is the POSITIVE observation that success
  happened -- the count moved, the test exercised the real path, the metric beat noise -- and that
  none of the failure modes could fake. Ruling out failures is necessary, not sufficient.
- Make the discriminator a concrete, checkable observation about a real artifact (a file, a test
  result, a committed diff, a metric), never about the plan file's own checkbox.
- evidence stays empty at planning; you fill it at sign-off and a fresh read-only judge checks it.

When the goals are drafted, present them and stop for review. Do not begin execution.`;

/* ─────────────────────────────────────────────────────────────────────────
 * 3. reminder — EXEC, appended to the injected plan when plan.md went
 *    untouched for a whole turn while goals are open. Wording stable (cache).
 * ──────────────────────────────────────────────────────────────────────── */
export const reminder = `\
<system-reminder>
Keep the plan file current as you work (edit it directly):
- tick finished subtasks ([/] in progress), add discovered ones
- append ONE short line to ## Log (append, don't rewrite earlier lines)
- when the active goal's discriminator is satisfied, fill its evidence: list (each item = a durable
  artifact + a short read of it), then call CompleteGoal. Don't tick a goal [x] before CompleteGoal
  accepts; the sign-off log line is the audit trail.
- if the file has grown long, prune finished goals (their evidence lives in git history and ## Log)
- otherwise keep working toward the active goal; don't stop to ask unless genuinely blocked
</system-reminder>`;

/* ─────────────────────────────────────────────────────────────────────────
 * 4. completeGoal — SIGN-OFF, agent-side: the one blessed tool
 * ──────────────────────────────────────────────────────────────────────── */
export const completeGoalDescription =
	"Sign off a goal once its discriminator is satisfied. First fill the goal's evidence: list in the " +
	"plan file: each item pairs a durable artifact with a short read of it (a quoted+linked log, a " +
	"table plus how to read it, a metric plus what it shows -- not a bare claim). The read must show " +
	"success POSITIVELY happened, not just that failures were avoided. Then call this with the goal's " +
	"text (the line after 'goal:'; small wording drift is fine). A fresh read-only judge inspects the " +
	"repo, runs the goal's verify command if it names one, and returns accept or reject with what's " +
	"missing. On accept (or if the judge itself is unavailable), a sign-off line is appended to ## Log " +
	"and YOU tick the goal [x]. On reject the goal stays open.";

export const completeGoalParamDescription = "The goal's text: the line after 'goal:' in the plan file.";

/* ─────────────────────────────────────────────────────────────────────────
 * 5. judge — SIGN-OFF, judge-side: the one rigorous check. Runs on a fresh
 *    read-only pi subprocess (--no-session) so it never sees the working
 *    agent's transcript. It gets the WHOLE plan file: it finds the goal,
 *    reads discriminator/failure modes/evidence itself (no parser between).
 * ──────────────────────────────────────────────────────────────────────── */
export const judgeSystem = `\
You are a read-only reviewer signing off a coding goal. Do not trust claims; verify.
Use read/grep/find/ls/bash to inspect the repository and the cited artifacts yourself. Re-read the
files, logs, and diffs the evidence points to; if something asserted isn't on disk, you can't
confirm it. If the goal names a verify: command, run it and check it really tests the discriminator
rather than passing tautologically. Judge whether the evidence shows the goal POSITIVELY succeeded
-- the discriminator's success signal is actually present, not just that the named failure modes
were dodged; a run can rule out every trap and still have produced nothing. Then check each subtle
failure mode is genuinely ruled out, not just unmentioned.

Finish with exactly these two lines and nothing after:
VERDICT: accept | reject
missing: <empty if accept; otherwise a short list of what's needed before this can be accepted>`;

export function judgeUser(p: { goal: string; plan: string; planPath: string }): string {
	return `\
The working agent claims this goal is complete:

  goal: ${p.goal}

Below is the full plan file (${p.planPath}). Find that goal in it (tolerate small wording drift; if
you cannot find a matching goal at all, reject and say so). Read its discriminator, subtle failure
modes, verify command, and evidence list from the file itself.

--- plan file ---
${p.plan}
--- end plan file ---

Inspect the repo and artifacts, run verify if present, then give your VERDICT.`;
}
