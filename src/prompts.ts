/**
 * pi-goals v2 — all model-facing text, in flow order.
 *
 * Design: the plan file is for LLMs and the human, not for TypeScript. No parser and no schema;
 * the skeleton below is a convention the drafting prompt teaches, the working agent maintains with
 * its normal Edit tool, and the goal steward reads natively. The harness does three things for a
 * cooperative-but-confused model: memory (a transient re-send of the plan when it goes stale),
 * format guidance (the skeleton), and supervision (a persistent read-only pi-subagents child).
 *
 * THE FOLD: everything above "## Log" is the working set (title, user voice, goals,
 * discriminators) and is what gets re-sent on the reminder cadence. Everything below it (Log,
 * Learnings, Appendix) is durable memory: unlimited, read on demand, and re-sent in full only at
 * session start and after a compaction, which is where the settled context is actually needed.
 *
 * Flow:
 *   SETUP (plan mode)     1. planDrafting   — draft goals into the plan file (read-only), sent once
 *   EXEC, on cadence      2. reminder       — the folded plan + upkeep nudge when it went stale
 *   EXEC, after compact   3. resync         — the WHOLE file back, once
 *   SIGN-OFF, agent-side  4. completeGoal*  — the one blessed tool's description
 *   SUPERVISION            steward.ts       — persistent review and sign-off prompts
 *
 * The goal's test is the DISCRIMINATOR: the concrete observation that tells real success from the
 * named subtle failure mode. Evidence is empty at planning and filled at sign-off.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * 1. planDrafting — SETUP, plan mode (read-only: edit/write blocked except the plan file)
 * ──────────────────────────────────────────────────────────────────────── */
export const planDrafting = `\
You are in plan mode. You are making a short judgeable plan that captures the user's real goals, then tests it in conversation.

1. Reduce technical uncertainty first. Use read-only repository tools or web search when either can
resolve a fact. Do not write or run code in this phase (edit/write are blocked except for the plan
file; don't mutate state via bash either).
2. Before you draft a goal, identify its object, observable result, scope, and any decision that the
human would need to approve later. If any is uncertain, reduce uncertainty now: inspect files or
search the web when they can answer, then ask the human to confirm your interpretation, pin down the
outcome or task, or approve an editorial or other preference choice. Do not present the review menu
with a placeholder goal such as "work out the thing", "improve it", or "investigate".
3. For independent high-impact questions, build a decision tree and ask the whole frontier in one
round. Ask only questions worth the human's time, where the answer materially reduces uncertainty
while discovering the right plan. Each question must be short and self-contained: state the relevant
context, use the human's language and ASD-STE100
Simple Technical English, and give a recommended answer. Record each answer in ## Interview. Do not
make the plan final while material user decisions remain open.
4. State the user-visible result before the goals: one concrete sentence naming what the human will
inspect when this plan is done. Take it from the original request, not from your implementation plan.
Every requested artifact and action must survive into this sentence. An agent-inferred constraint may
not replace, defer, or contradict it; ask the human if an inference would change the result.
5. When every goal has an object, observable result, settled scope, and required approval, draft the
plan file and present it. It should be safe to work overnight and present the requested outcome.

How this mode ends: after each settled draft the human gets a menu (Ready / Refine / Edit / Cancel).
Plan mode ends only when they pick Ready. Refine collects short revision notes. Edit opens the full
plan. When a new requirement arrives, fold it in, say what changed, and present the plan again.
Detail that doesn't change a goal or a discriminator belongs in the appendix, not in the goals.

Right-size it:
- One goal per distinct judgeable outcome. Group related goals when it helps judge them together
  and readability. The count flows from the outcomes.
- Describe outcomes in qualitative terms the steward and user can discriminate.
	- Use the users language or more precise don't transform "MV" into "knob" as it looses precision and is overloaded
	- Don't invent metrics or thresholds for problems you haven't explored yet — the steward should know it when it sees the outcome.
  	- Quantitative gates are fine only when you are certain they survive contact with reality.
- Subtasks are the steps inside a goal; add them when a goal has 3+ distinct steps, skip otherwise.
- Two goals that share one discriminator are one goal. Merge them.
- Keep the goal subject short. Put its important scope, failure modes, discriminator, tasks, and evidence in the indented block beneath it. The steward reads the whole block and the whole plan.
- Keep the working set under 50 lines, excluding ## User voice. ## User voice has no line limit: quote
  the human fully rather than shorten or paraphrase them. Everything below "## Log" is unlimited.

Style: Make it easy for a busy and forgetfull user to review. Use ASD-STE100 Simplified Technical English. Use active voice, one idea per sentence, common words,
the same word for the same thing, and define a new terms at first use. Use redundant context for skim readers e.g. "our output - the cells, CV tag" is easy to read and reminds context. This covers the context
paragraph and the appendix too, not just the checklist. No all-caps headers and no bold spam. Just write less, add your voice less, persuade less, and burden the reader less.

Write the plan file in roughly this shape -- the file is read directly by the human and the goal steward, so clarity beats conformance; small deviations are fine):

# <short plan title>

<context: one short paragraph. What the human wants and why.>

## User-visible result

<one concrete sentence naming the final artifact or behavior the human will inspect>

## User voice

- > "<the human's requirement, quoted in full word for word (with spelling fixes)>"

## Goals

1. [ ] goal: <one short jugable imperative outcome>
  - subtle failure mode: <a way this could look done but isn't>
  - discriminator: <the concrete observation that tells real success from that failure>
  - verify: <optional shell command that exits 0 only when the discriminator passes; omit if not
    testable. YOU run it at sign-off time and save its output as evidence; the steward only reads>
  - tasks:
    1. [ ] <subtask>
  - evidence: (empty until sign-off)

## Future work / out of scope

<-- the fold: everything below here is durable memory, not the working set -->

## Log
### {date}

## Interview

## Learnings

## Papercuts - problems, gotchas, suggestions

## Appendix (context, not approved)

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
- evidence stays empty at planning; you fill it at sign-off and the read-only goal steward checks it.
  Cite durable artifacts a future reader can open: committed files, test names, git diffs. .pi/ is
  usually gitignored, so files there prove things only at steward review time, not in history.
- User-visible result: restate the original deliverable, not the proposed implementation. Every goal
  must contribute to it. Future work may not defer any artifact or action named there.
- User voice: quote the human word for word, one line per requirement, as they say it. Never
  paraphrase there -- a paraphrase drifts, and then the goals churn on the next reply. It is exempt
  from the working-set line limit. Never put an agent inference in User voice.
- Interview: every human reply in plan mode is stored here verbatim as a dated blockquote. It is
  durable memory below the fold, not a substitute for ## User voice.
- Rejected options stay visible: ~~struck through~~ with who rejected them and why, so nobody
  relitigates them.
- Learnings: one line per gotcha that a future reader would otherwise rediscover. Write down what
  you saw from a source that does not persist (a browser page, an image, a long log tail) before
  you do anything else with it.
- Appendix: unlimited and unverified. Alternatives, links, dead ends, and the settled detail that
  is not part of the approved goals. Nothing here is approved and nothing here is checked.

When the goals are drafted, present them and say the plan is final. Do not begin execution.`;

/* ─────────────────────────────────────────────────────────────────────────
 * 3. reminder — EXEC. Transient, never persisted, and only when the plan went stale for a couple of
 *    turns. pi-tasks tried a per-turn injection and deleted it: "wallpaper noise that trains the
 *    model to ignore the task block" (tintinweb/pi-tasks CHANGELOG.md:149). Carries the folded plan
 *    (above ## Log), because a nudge with no plan in it makes the model go read the file anyway.
 * ──────────────────────────────────────────────────────────────────────── */
export function planningState(planPath: string): string {
	return `\
[PLANNING MODE]
The plan at ${planPath} is the only file you may change. Use read-only repository tools or web search
when either can resolve a fact. Ask the human to confirm unresolved interpretation, outcome, task,
scope, or a choice that needs their approval. Batch independent high-impact questions in one short,
self-contained round with relevant context and a recommendation. Do not draft a placeholder goal
without a concrete object, observable result, settled scope, and required approval. Do not execute
work, mark a goal [/] or [x], or sign off a goal. The plan is not approved until the human selects
Ready.`;
}

export function reminder(foldedPlan: string, planRel: string): string {
	return `\
<system-reminder>
Your plan (${planRel}, above the fold; the log, learnings and appendix are in the file):

${foldedPlan}

Keep it current as you work, with your normal edit tool:
- tick finished subtasks ([/] in progress), add discovered ones
- append ONE short line to ## Log, and a line to ## Learnings for a gotcha worth keeping
- when the active goal's discriminator is satisfied, fill its evidence: list (each item = a durable
  artifact + a verbatim quote you actually observed + a short read of it), then call CompleteGoal.
  Don't tick a goal [x] before CompleteGoal accepts; the sign-off log line is the audit trail.
- if the working set has grown long, prune finished goals (their evidence lives in git history and
  ## Log) and move settled detail down to ## Appendix, which is unlimited
- the human's latest message outranks this plan. If it corrects the deliverable or scope, amend the
  user-visible result, user voice, and affected goals before continuing; don't defend the old plan
- otherwise keep working toward the active goal; don't stop to ask unless genuinely blocked
</system-reminder>`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 3b. resync — EXEC, one-shot at session start and after a compaction: the WHOLE file back,
 *     appendix included. Modelled on pi-goal-x's [POST-COMPACTION RESYNC] one-shot. This is the
 *     only place the below-the-fold sections are pushed; otherwise the agent reads them on demand.
 * ──────────────────────────────────────────────────────────────────────── */
export function resync(plan: string, planRel: string, why: string): string {
	return `\
<system-reminder>
${why} This is the whole plan file (${planRel}), appendix included. Keep working the active goal;
edit the file directly as you go. The human's latest message outranks the plan: if it corrects the
deliverable or scope, amend the plan rather than preserving an obsolete decision.

${plan}
</system-reminder>`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 4. completeGoal — SIGN-OFF, agent-side: the one blessed tool
 * ──────────────────────────────────────────────────────────────────────── */
export const completeGoalDescription =
	"Sign off a goal once its discriminator is satisfied. First fill the goal's evidence: list in the " +
	"plan file: each item pairs a durable artifact with a short read of it (a quoted+linked log, a " +
	"table plus how to read it, a metric plus what it shows -- not a bare claim). Quote verbatim from " +
	"output you actually observed; never reconstruct numbers from memory. If you couldn't see an " +
	"output, rerun it or write that you couldn't -- an honest gap beats a plausible fabrication. If " +
	"the goal names a verify: command, run it yourself first and save its output to a file cited in " +
	"the evidence: the goal steward cannot execute anything and will reject a claimed pass with no saved " +
	"output. The read must show success POSITIVELY happened, not just that failures were avoided. " +
	"Check that the claimed result uses the artifact and outcome named in User-visible result and does " +
	"not substitute an agent-inferred deliverable. Then call this with the goal's text (the line after " +
	"'goal:'; small wording drift is fine). The persistent read-only goal steward rereads the complete " +
	"plan, inspects the LIVE WORKING TREE (uncommitted changes included), and returns accept or reject " +
	"with what is missing. On accept, a sign-off line is appended to ## Log and the goal is ticked [x] " +
	"for you; the result says if you must tick it yourself. On reject or steward failure, the goal stays open.";

export const completeGoalParamDescription = "The goal's text: the line after 'goal:' in the plan file.";
