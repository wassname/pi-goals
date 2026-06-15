/**
 * pi-plan — all model-facing text, in flow order.
 *
 * Philosophy: the form guides a process; it does not police one. The agent can
 * edit plan.md freely. These prompts + the plan.md structure make the right path
 * the easy path. The only step that is genuinely rigorous is the evidence judge
 * (6), and even that is reached by guiding the agent to call CompleteGoal, not by
 * trapping it. Bypasses stay visible in the git diff and the widget.
 *
 * Flow:
 *   SETUP (plan mode)     1. planDrafting        — strong/sticky model drafts goals
 *   EXEC, each turn start 2. planInjection       — "here is your plan, where you are"
 *   EXEC, periodic        3. reminder            — the typed nudge that drives upkeep + autonomy
 *   EXEC, loop continue   4. continuation        — keep going toward the active goal
 *   EXEC, after each turn 5. loopJudge           — continue / pause (cheap, foolable, ok)
 *   SIGN-OFF              6. evidenceJudge        — read-only verify (rigorous; the one real check)
 *
 * Read top to bottom to see the whole process. 5 and 6 are kept adjacent on
 * purpose: the cheap-foolable vs must-not-be-fooled contrast is the design.
 *
 * WIRED in index.ts: 1 planDrafting, 2 planInjection, 3 reminder, 6 evidenceJudge.
 * NOT YET WIRED: 4 continuation and 5 loopJudge define the autonomous re-prompt loop, which is
 * intentionally not built in v1 (an until-done-style loop was judged too complex). They stay here so
 * the full intended flow is reviewable; wire them if/when the loop is added.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * 1. planDrafting  —  SETUP, plan mode
 *
 * System guidance for the plan-phase agent. Runs on the plan model (may differ
 * from the execution model; the choice is sticky — see oracle.json-style config).
 * This phase is read-only: explore, then draft goals into plan.md. No code yet.
 * The field requirements here are the whole "elicitation" — get them agreed up
 * front, because the human reviews this output before any execution.
 * ──────────────────────────────────────────────────────────────────────── */
export const planDrafting = `\
You are in plan mode. Explore the repository read-only, then draft a plan into plan.md.
Do not write or run code in this phase. Produce goals the human will review and approve.

Write each goal in this shape:

## Goal: <one short imperative line>
status: open
done_when: <a falsifiable check, plus the symptom you'd see if it's NOT met>
verify: <a shell command that exits 0 only when the goal is met — include this whenever
         success is expressible as tests/lint/build/a threshold; omit it otherwise>
failure_modes:
  - <a concrete way this could look done but isn't>
  - <another>
  - <if verify exists: "verify passes on a trivial or gamed test">
- [ ] <first subtask>
- [ ] <next subtask>

Rules for a good plan:
- Keep goals small enough that done_when is checkable in one sitting.
- done_when must be falsifiable. "Works well" is not a criterion; "p95 < 50ms on bench-X,
  else timeouts in load-test.log" is.
- failure_modes are a pre-mortem: the cheap, specific ways a later "done" could be wrong.
  This is the highest-value part — it shapes what evidence you'll collect.
- Prefer a verify command. A green deterministic check is worth more than a paragraph of
  description, and it's the first thing checked at sign-off.

When the plan is drafted, present it and stop for review. Do not begin execution.`;

/* ─────────────────────────────────────────────────────────────────────────
 * 2. planInjection  —  EXEC, injected at each agent start (and after compaction)
 *
 * A late user-role message, NOT a system-prompt mutation (keeps the prefix cache
 * valid). Built from the parsed plan. MUST be byte-identical when nothing changed:
 * fixed field order, no volatile timestamps in the body. Pass only the active
 * goal + its open subtasks + the last log line — not the whole file.
 * ──────────────────────────────────────────────────────────────────────── */
export function planInjection(p: {
  objective: string;
  activeGoal: { subject: string; done_when: string; openSubtasks: string[] } | null;
  lastLogLine: string | null;
  counts: { done: number; open: number };
}): string {
  if (!p.activeGoal) {
    return `Plan (plan.md): ${p.objective}\nNo active goal. ${p.counts.open} open, ${p.counts.done} done. Pick the next goal or run /plan.`;
  }
  const subtasks = p.activeGoal.openSubtasks.length
    ? p.activeGoal.openSubtasks.map((s) => `  - [ ] ${s}`).join("\n")
    : "  (no open subtasks)";
  return `\
Plan (plan.md): ${p.objective}
Active goal: ${p.activeGoal.subject}
done_when: ${p.activeGoal.done_when}
Open subtasks:
${subtasks}
Last log: ${p.lastLogLine ?? "(none yet)"}
Progress: ${p.counts.done} done, ${p.counts.open} open.`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 3. reminder  —  EXEC, periodic system-reminder
 *
 * The typed nudge. This is both the housekeeping and the autonomy engine — it is
 * what makes the process get followed without a hard gate. Fires after N
 * file-modifying turns since the last plan.md update while a goal is active.
 * Keep the wording stable so it doesn't thrash the cache.
 * ──────────────────────────────────────────────────────────────────────── */
export const reminder = `\
<system-reminder>
Keep plan.md current as you work:
- tasks: tick the subtasks you've finished; add any new ones you've discovered.
- log: append ONE short line to ## Log (append — don't rewrite earlier lines).
- goal: if the active goal's evidence is in, sign it off by calling CompleteGoal with that
  evidence. Don't edit status to done by hand — CompleteGoal runs the check and records it.
- otherwise: keep working toward the active goal. Don't stop to ask unless you're genuinely
  blocked; if blocked, say what's blocking and why.
</system-reminder>`;

/* ─────────────────────────────────────────────────────────────────────────
 * 4. continuation  —  EXEC, the loop's "keep going" turn
 *
 * Hermes-style. A plain user-role message appended when the loop judge (5) says
 * continue. Does not mutate the system prompt, so the cache holds.
 * ──────────────────────────────────────────────────────────────────────── */
export const continuation = `\
Continue toward the active goal in plan.md. If it now meets its done_when, call CompleteGoal
with your evidence (point to durable artifacts — saved logs, committed diffs, files — not just
claims). If you're blocked, state what's blocking it.`;

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
doubt, continue. You are not verifying correctness — a later read-only judge does that.
Reply with ONLY a JSON object, no other text: {"done": boolean, "reason": "<one sentence>"}.
Set done=true only if the agent's last message shows the active goal's done_when is met, or
the agent says it is blocked and needs the human.`;

export function loopJudgeUser(p: { activeGoalDoneWhen: string; lastResponse: string }): string {
  return `\
Active goal done_when: ${p.activeGoalDoneWhen}

Agent's last message:
"""
${p.lastResponse}
"""

{"done": ?, "reason": ?}`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 6. evidenceJudge  —  SIGN-OFF, the one rigorous check
 *
 * Runs inside CompleteGoal, on the read-only oracle subprocess (fresh context,
 * strongest reasoning on the chosen provider; override to a different vendor for
 * high-stakes goals). It re-derives from the repo rather than trusting the
 * agent's transcription, and it judges whether a verify command actually tests
 * the criterion or could pass while a named failure mode holds (gaming).
 *
 * The transport gives it read/grep/find/ls. The prompt below imposes the verdict
 * contract — the oracle returns prose by default, so parse the VERDICT line.
 * ──────────────────────────────────────────────────────────────────────── */
export const evidenceJudgeSystem = `\
You are a read-only reviewer signing off a coding goal. Do not trust claims — verify.
Use read/grep/find/ls to inspect the repository and the cited artifacts yourself. Re-read the
files, logs, and diffs the evidence points to; if something it asserts isn't on disk, you can't
confirm it. If a verify command was run, judge whether it genuinely tests the criterion or
could pass while one of the listed failure modes still holds — a tautological or skipped test
is a reject. Check each failure mode is actually ruled out, not just unmentioned.

Finish with exactly these two lines and nothing after:
VERDICT: accept | reject
missing: <empty if accept; otherwise a short list of what's needed before this can be accepted>`;

export function evidenceJudgeUser(p: {
  subject: string;
  done_when: string;
  verify: string | null;
  verifyResult: { command: string; exitCode: number; outputTail: string } | null;
  failure_modes: string[];
  evidence: string;
  paths: string[];
}): string {
  const verifyBlock = p.verify
    ? `verify command: ${p.verify}\nverify result: exit ${p.verifyResult?.exitCode ?? "n/a"}\n${p.verifyResult?.outputTail ?? ""}`
    : "verify command: none (no deterministic check for this goal)";
  return `\
Goal: ${p.subject}
done_when: ${p.done_when}
failure_modes:
${p.failure_modes.map((f) => `  - ${f}`).join("\n")}

${verifyBlock}

Agent's evidence:
${p.evidence}

Artifacts it points to (inspect these):
${p.paths.map((x) => `  - ${x}`).join("\n") || "  (none listed — note this)"}

Verify the goal against its done_when. Then give your VERDICT.`;
}
