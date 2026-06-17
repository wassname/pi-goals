/**
 * pi-goals — all model-facing text, in flow order.
 *
 * Philosophy: the form guides a process; it does not police one. The agent can
 * edit goals.md freely. These prompts + the goals.md structure make the right path
 * the easy path. The only step that is genuinely rigorous is the evidence judge
 * (7), and even that is reached by guiding the agent to call CompleteGoal, not by
 * trapping it. Bypasses stay visible in the git diff and the widget.
 *
 * Flow (this file is ordered the way the agent meets each text, so it reads as one pass):
 *   SETUP (plan mode)     1. planDrafting        — drafts goals (read-only phase)
 *   EXEC, each turn start 2. planInjection       — "here is your plan, where you are"
 *   EXEC, periodic        3. reminder            — the typed nudge that drives upkeep + autonomy
 *   EXEC, loop continue   4. continuation        — keep going toward the active goal
 *   EXEC, after each turn 5. loopJudge           — continue / pause (cheap, foolable, ok)
 *   SIGN-OFF, agent-side  6. completeGoalTool    — the CompleteGoal tool desc + param the agent reads
 *   SIGN-OFF, judge-side  7. evidenceJudge       — read-only verify (rigorous; the one real check)
 *
 * Read top to bottom to see the whole process. 5 and 7 embody the design contrast:
 * the cheap-foolable loop gate vs the must-not-be-fooled sign-off.
 *
 * WIRED in index.ts: 1 planDrafting, 2 planInjection, 3 reminder, 6 completeGoalTool, 7 evidenceJudge.
 * NOT YET WIRED: 4 continuation and 5 loopJudge define the autonomous re-prompt loop, which is
 * intentionally not built in v1 (an until-done-style loop was judged too complex). They stay here so
 * the full intended flow is reviewable; wire them if/when the loop is added.
 *
 * The goal's test is the DISCRIMINATOR: the concrete observation that tells real success from the
 * named subtle failure mode. It replaces a vague "done_when". Evidence is empty at planning and
 * filled at sign-off (you don't always know the exact artifacts up front; the judge checks them then).
 */

/* ─────────────────────────────────────────────────────────────────────────
 * 1. planDrafting  —  SETUP, plan mode
 *
 * System guidance for the plan-phase agent. This phase is read-only (edit/write
 * and mutating bash are blocked by a tool hook): explore, then draft goals into
 * goals.md. The fields here are the whole "elicitation"; the human reviews this
 * output before any execution.
 * ──────────────────────────────────────────────────────────────────────── */
export const planDrafting = `\
You are in plan mode. The objective may arrive through conversation, not as one up-front command.
Explore the repository read-only first, then ask: resolve discoverable facts by looking them up, and
only ask the human when the answer is a genuine intent or preference choice that exploration can't
settle. Don't write goals that branch on something you could just check. Do not write or run code in
this phase (edit and write are blocked, and so is mutating bash). If the ask is itself read-only
(e.g. research, a search, a report), explore enough to scope it, but leave the actual deliverable for
after the human approves the plan. When the objective is clear, draft goals into goals.md and stop
for review. Produce a plan the human will review and approve.

Right-size it, don't force structure that isn't there:
- Default to ONE goal. Add another only when it's a genuinely separate checkpoint you'd want signed
  off on its own (it can pass or fail independently). Most objectives are 1-2 goals.
- Subtasks are the steps inside a goal. Add them when a goal has 3+ distinct steps; skip them for a
  single-action goal. Don't pad with trivial steps.
- Don't invent goals to look thorough. When in doubt, merge.

Write the whole file in this shape (markdown checkboxes, made to be skim-reviewed):

# <short plan title>

<context: restate the user's ask, their stated preferences, and any decisions you've agreed on>

## Goals

1. [ ] goal: <one short imperative line>
  - subtle failure mode: <a way this could look done but isn't>
  - discriminator: <the concrete observation that tells real success from that failure>
  - verify: <optional shell command that exits 0 only when the discriminator passes; omit if not testable>
  - tasks:
    1. [ ] <subtask>
    2. [ ] <subtask>
  - evidence:
    - <leave empty now; filled at sign-off>
2. [ ] goal: <...>

# Future work / out of scope

- <anything deliberately not in these goals>

## Log

Keep it lean and legible:
- A goal is a checkbox line beginning "goal:"; its state is the checkbox ([ ] open, [/] active, [x]
  done, [-] cancelled). Leave goals [ ] at planning. The number is just for the human to reference.
- subtle failure mode + discriminator are the heart of this. List the ways a "done" could look
  achieved but not be (empty/zero-count output, a silently-errored step, a gamed test, a flat/no-op
  result that dodged every trap and still showed nothing; these are examples, find the ones that fit).
- The discriminator is the POSITIVE observation that the goal actually succeeded AND that none of
  those failure modes could have produced. It must show success happened -- the count moved the right
  way, the test really exercised the path, the metric beat noise -- not merely that a failure was
  ruled out: avoiding every failure mode is necessary, not sufficient. Name the success signal first,
  then check it isn't something a failure mode could fake. Keep it terse.
- The discriminator is the success test, written now, in place of a vague "done": make it a concrete,
  checkable observation about a real artifact (a file, a test result, a committed diff, a metric), not
  about goals.md's own checkbox.
- subtasks: any checkbox WITHOUT a "goal:" prefix, under "- tasks:". Use [/] for in progress and [-]
  for cancelled/impossible.
- verify: prefer one when the discriminator is a test, build, threshold, or metric: a green check or
  a printed number beats prose. Omit it otherwise.
- evidence stays empty at planning. You don't always know the exact artifacts up front, and that's
  fine: you fill evidence at sign-off, and a fresh read-only judge checks it then.

When the goals are drafted, present them and stop for review. Do not begin execution.`;

/* ─────────────────────────────────────────────────────────────────────────
 * 2. planInjection  —  EXEC, injected at each agent start (and after compaction)
 *
 * A late user-role message, NOT a system-prompt mutation (keeps the prefix cache
 * valid). Built from the parsed plan. MUST be byte-identical when nothing changed:
 * fixed field order, no volatile timestamps. Pass only the active goal + its open
 * subtasks + the last log line, not the whole file.
 * ──────────────────────────────────────────────────────────────────────── */
export function planInjection(p: {
  title: string;
  activeGoal: { subject: string; discriminator: string[]; openSubtasks: string[] } | null;
  lastLogLine: string | null;
  counts: { done: number; open: number };
}): string {
  if (!p.activeGoal) {
    // FIXME(heading): user wants the heading to show ".pi/goals.md: <title>" so the filename is explicit
    // even in the injection. Currently says "Goals (goals.md):" which is close but not the same.
    return `.pi/goals.md: ${p.title}\nNo active goal. ${p.counts.open} open, ${p.counts.done} done. Pick the next goal (set its checkbox to [/]) or run /goals.`;
  }
  const subtasks = p.activeGoal.openSubtasks.length
    ? p.activeGoal.openSubtasks.map((s) => `  - [ ] ${s}`).join("\n")
    : "  (no open subtasks)";
  const disc = p.activeGoal.discriminator.length ? p.activeGoal.discriminator.join("; ") : "(none set)";
  return `\
.pi/goals.md: ${p.title}
Active goal: ${p.activeGoal.subject}
discriminator (the success test): ${disc}
Open subtasks:
${subtasks}
Last log: ${p.lastLogLine ?? "(none yet)"}
Progress: ${p.counts.done} done, ${p.counts.open} open.`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 3. reminder  —  EXEC, periodic system-reminder
 *
 * The typed nudge. This is both the housekeeping and the autonomy engine — it is
 * what makes the process get followed without a hard gate. Fires after a turn that
 * left goals.md untouched while a goal is active. Keep the wording stable so it
 * doesn't thrash the cache.
 * ──────────────────────────────────────────────────────────────────────── */
export const reminder = `\
<system-reminder>
Keep goals.md current as you work:
- tasks: tick the subtasks you've finished ([/] for in progress); add any you've discovered.
- log: append ONE short line to ## Log (append, don't rewrite earlier lines).
- goal: when the active goal's discriminator is satisfied, fill its evidence: block in goals.md (a
  list pointing at durable artifacts), then call CompleteGoal with the goal's desc. Don't tick the
  goal [x] by hand; CompleteGoal reads the evidence, runs the check, and writes [x].
- otherwise: keep working toward the active goal. Don't stop to ask unless you're genuinely blocked;
  if blocked, say what's blocking it.
</system-reminder>`;

/* ─────────────────────────────────────────────────────────────────────────
 * 4. continuation  —  EXEC, the loop's "keep going" turn
 *
 * Hermes-style. A plain user-role message appended when the loop judge (5) says
 * continue. Does not mutate the system prompt, so the cache holds.
 * ──────────────────────────────────────────────────────────────────────── */
export const continuation = `\
Continue toward the active goal in goals.md. If its discriminator is now satisfied, fill the goal's
evidence: block (durable artifacts, e.g. saved logs, committed diffs, files, not just claims) and
then call CompleteGoal with the goal's desc. If you're blocked, state what's blocking it.`;

/* ─────────────────────────────────────────────────────────────────────────
 * 5. loopJudge  —  EXEC, runs after each turn to decide continue / pause
 *
 * Cheap, conservative, fail-open. Reads only the agent's last response, so it CAN
 * be fooled by an asserted "done" — that's acceptable: its worst case is a
 * premature pause, caught by you or the iteration budget. It does NOT sign goals
 * off; that's the evidence judge's job. Return strict JSON, no prose.
 * ──────────────────────────────────────────────────────────────────────── */
export const loopJudgeSystem = `\
You decide whether an autonomous coding agent should keep working or pause for the human.
Be conservative: only pause when the work is plainly finished or plainly blocked. When in
doubt, continue. You are not verifying correctness; a later read-only judge does that.
Reply with ONLY a JSON object, no other text: {"done": boolean, "reason": "<one sentence>"}.
Set done=true only if the agent's last message shows the active goal's discriminator is satisfied,
or the agent says it is blocked and needs the human.`;

export function loopJudgeUser(p: { discriminator: string; lastResponse: string }): string {
  return `\
Active goal discriminator (the success test): ${p.discriminator}

Agent's last message:
"""
${p.lastResponse}
"""

{"done": ?, "reason": ?}`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 6. completeGoalTool  —  SIGN-OFF, agent-side
 *
 * The description + param the agent reads on the one blessed tool, CompleteGoal.
 * This is where the agent meets the sign-off: it fills evidence and calls the
 * tool, which then runs verify + the judge (7). Kept here with the rest of the
 * model-facing text so the whole process reads top to bottom.
 * ──────────────────────────────────────────────────────────────────────── */
export const completeGoalDescription =
	"Sign off a goal once its discriminator is satisfied. First fill the goal's evidence: block in " +
	"goals.md: a list where each item pairs a durable artifact with a short read of it (a quoted+linked " +
	"log, a table plus how to read it, or a metric plus what it shows; quote the key lines and link the " +
	"rest, not a pasted blob or a bare claim). The read must show the success POSITIVELY happened (the " +
	"result is present, the count moved the right way, the metric beat noise), not just that a failure " +
	"was avoided; ruling out the failure modes is necessary but not sufficient. Then call this with the " +
	"goal's desc (the text after 'goal:'). Runs the goal's verify command (if any) then a read-only " +
	"subagent that inspects that evidence against the repo and the discriminator. On accept, the goal is " +
	"marked done and logged; on reject, it stays open and you get what is missing. The subagent's " +
	"reasoning is returned either way.";

export const completeGoalParamDescription = "The goal's desc: the exact text after 'goal:' in its line.";

/* ─────────────────────────────────────────────────────────────────────────
 * 7. evidenceJudge  —  SIGN-OFF, judge-side; the one rigorous check
 *
 * Runs inside CompleteGoal, on a read-only pi subprocess (fresh context via
 * --no-session, so it never sees the working agent's transcript; override to a
 * different vendor for an independent cross-family check). It re-derives from the
 * repo rather than trusting the agent's transcription, and judges whether the
 * evidence satisfies the discriminator and rules out the named failure mode.
 *
 * The transport gives it read/grep/find/ls. The prompt below imposes the verdict
 * contract — the subprocess returns prose by default, so parse the VERDICT line.
 * ──────────────────────────────────────────────────────────────────────── */
export const evidenceJudgeSystem = `\
You are a read-only reviewer signing off a coding goal. Do not trust claims; verify.
Use read/grep/find/ls to inspect the repository and the cited artifacts yourself. Re-read the
files, logs, and diffs the evidence points to; if something it asserts isn't on disk, you can't
confirm it. Judge whether the evidence shows the goal POSITIVELY succeeded -- the discriminator's
success signal is actually present, not just that the failure modes were dodged. Avoiding every
failure mode is necessary but not sufficient: a run can rule out each trap and still have produced
nothing, so reject "no problems found" that lacks the positive result. Then check the named subtle
failure modes are genuinely ruled out, not just unmentioned. If a verify command was run,
judge whether it really tests the discriminator or could pass while the failure mode still holds; a
tautological or skipped test is a reject.

Finish with exactly these two lines and nothing after:
VERDICT: accept | reject
missing: <empty if accept; otherwise a short list of what's needed before this can be accepted>`;

export function evidenceJudgeUser(p: {
  subject: string;
  discriminator: string[];
  failure_modes: string[];
  verify: string | null;
  verifyResult: { command: string; exitCode: number; outputTail: string } | null;
  evidence: string;
  paths: string[];
}): string {
  const verifyBlock = p.verify
    ? `verify command: ${p.verify}\nverify result: exit ${p.verifyResult?.exitCode ?? "n/a"}\n${p.verifyResult?.outputTail ?? ""}`
    : "verify command: none (no deterministic check for this goal)";
  return `\
Goal: ${p.subject}
discriminator (must be satisfied):
${p.discriminator.map((d) => `  - ${d}`).join("\n") || "  (none stated, note this)"}
subtle failure modes (must be ruled out):
${p.failure_modes.map((f) => `  - ${f}`).join("\n") || "  (none stated)"}

${verifyBlock}

Agent's evidence:
${p.evidence}

Artifacts it points to (inspect these):
${p.paths.map((x) => `  - ${x}`).join("\n") || "  (none listed, note this)"}

Verify the evidence satisfies the discriminator and rules out the failure modes. Then give your VERDICT.`;
}
