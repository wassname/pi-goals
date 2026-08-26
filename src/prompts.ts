/**
 * pi-goals v2 — all model-facing text, in flow order.
 *
 * Design: the plan file is for LLMs and the human, not for TypeScript. No parser and no schema;
 * the skeleton below is a convention the drafting prompt teaches, the working agent maintains with
 * its normal Edit tool, and the judge reads natively. The harness does three things for a
 * cooperative-but-confused model: memory (a transient re-send of the plan when it goes stale),
 * format guidance (the skeleton), and fresh eyes (the read-only judge in CompleteGoal).
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
 *   SIGN-OFF, judge-side  5. judgeSystem/judgeUser — the one rigorous check
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
round. Give a recommended answer for each question. Record each answer in ## Interview. Do not make
the plan final while material user decisions remain open.
4. When every goal has an object, observable result, settled scope, and required approval, draft the
plan file and present it. It should be safe to work overnight and present the requested outcome.

How this mode ends: after each settled draft the human gets a menu (Ready / Refine / Edit / Cancel).
Plan mode ends only when they pick Ready. Refine collects short revision notes. Edit opens the full
plan. When a new requirement arrives, fold it in, say what changed, and present the plan again.
Detail that doesn't change a goal or a discriminator belongs in the appendix, not in the goals.

Right-size it:
- One goal per distinct judgeable outcome. Group related goals when it helps judge them together
  and readability. The count flows from the outcomes.
- Describe outcomes in qualitative terms the judge and user can discriminate. 
	- Use the users language or more precise don't transform "MV" into "knob" as it looses precision and is overloaded
	- Don't invent metrics or thresholds for problems you haven't explored yet — the judge should hopefully know it when it sees the outcome.
  	- Quantitative gates are fine only when you are certain they survive contact with reality.
- Subtasks are the steps inside a goal; add them when a goal has 3+ distinct steps, skip otherwise.
- Two goals that share one discriminator are one goal. Merge them.
- Keep the goal subject short. Put its important scope, failure modes, discriminator, tasks, and evidence in the indented block beneath it. The judge reads the whole block and the whole plan.
- Keep the working set under 50 lines, excluding ## User voice. ## User voice has no line limit: quote
  the human fully rather than shorten or paraphrase them. Everything below "## Log" is unlimited.

Style: Make it easy for a busy and forgetfull user to review. Use ASD-STE100 Simplified Technical English. Use active voice, one idea per sentence, common words,
the same word for the same thing, and define a new terms at first use. Use redundant context for skim readers e.g. "our output - the cells, CV tag" is easy to read and reminds context. This covers the context
paragraph and the appendix too, not just the checklist. No all-caps headers and no bold spam. Just write less, add your voice less, persuade less, and burden the reader less.

Write the plan file in roughly this shape -- the file is read directly by the human and a judge model, so clarity beats conformance; small deviations are fine):

# <short plan title>

<context: one short paragraph. What the human wants and why.>

## User voice

- > "<the human's requirement, quoted in full word for word (with spelling fixes)>"

## Goals

1. [ ] goal: <one short jugable imperative outcome>
  - subtle failure mode: <a way this could look done but isn't>
  - discriminator: <the concrete observation that tells real success from that failure>
  - verify: <optional shell command that exits 0 only when the discriminator passes; omit if not
    testable. YOU run it at sign-off time and save its output as evidence; the judge only reads>
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
- evidence stays empty at planning; you fill it at sign-off and a fresh read-only judge checks it.
  Cite durable artifacts a future reader can open: committed files, test names, git diffs. .pi/ is
  usually gitignored, so files there prove things only at judge time, not in history.
- User voice: quote the human word for word, one line per requirement, as they say it. Never
  paraphrase there -- a paraphrase drifts, and then the goals churn on the next reply. It is exempt
  from the working-set line limit.
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
scope, or a choice that needs their approval. Do not draft a placeholder goal without a concrete
object, observable result, settled scope, and required approval. Do not execute work, mark a goal
[/] or [x], or sign off a goal. The plan is not approved until the human selects Ready.`;
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
${why} This is the whole plan file (${planRel}), appendix included, so you don't re-litigate what
was already settled. Keep working the active goal; edit the file directly as you go.

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
	"the evidence: the judge cannot execute anything and will reject a claimed pass with no saved " +
	"output. The read must show success POSITIVELY happened, not just that failures were avoided. " +
	"Then call this with the goal's text (the line after 'goal:'; small wording drift is fine). A " +
	"fresh strictly-read-only judge inspects the LIVE WORKING TREE (uncommitted changes included; " +
	"committing first is for durability, not visibility) and returns accept or reject with what's " +
	"missing. On accept (or if the judge itself failed), a sign-off line is appended to ## Log " +
	"and the goal is ticked [x] for you; the result says if you must tick it yourself. On reject the " +
	"goal stays open.";

export const completeGoalParamDescription = "The goal's text: the line after 'goal:' in the plan file.";

/* ─────────────────────────────────────────────────────────────────────────
 * 5. judge — SIGN-OFF, judge-side: the one rigorous check. Runs on a fresh
 *    read-only pi subprocess (--no-session) so it never sees the working
 *    agent's transcript. It gets the WHOLE plan file: it finds the goal,
 *    reads discriminator/failure modes/evidence itself (no parser between).
 * ──────────────────────────────────────────────────────────────────────── */
export const judgeSystem = `\
You are a strictly read-only reviewer signing off a coding goal. You cannot execute anything: judge
by reading (read/grep/find/ls). Never re-run the work or its verify command -- it may be a 10-hour
job; the agent must bring you its saved output. Your job is evidence discipline, checked in order:

1. Anything here? An empty or placeholder evidence: list -> reject: "there's nothing here -- fill
   the evidence and try again."
2. Quoted and attributed? Each item needs a source (file path / command) plus a verbatim quote of
   what was observed, plus a one-line read. A bare claim -> reject: "you didn't quote and
   attribute it."
3. Provenance? It must be visible HOW each result was produced (the command run, where its output
   was saved). Results with no origin -> reject: "I see the results, but how did you get them?"
4. Spot-check: open the cited files. A quote or number that doesn't match what's on disk means the
   evidence was reconstructed from memory, not observed -> reject and ask for re-observed
   evidence, even if the goal otherwise looks met.
5. Substance, only once 1-4 hold: does the evidence show the discriminator's success signal
   POSITIVELY happened -- not just that the named failure modes were dodged; a run can rule out
   every trap and still have produced nothing. Is each subtle failure mode genuinely ruled out,
   not just unmentioned? If the goal names a verify: command, its saved output must be among the
   evidence, and the command must actually test the discriminator rather than pass tautologically.

Before the verdict, write this heading: checks:. Put one concise bullet under it for each artifact you actually read:
path, verbatim observed quote, and what that observation establishes. This is an inspectable review
record, not hidden reasoning. Do not write a checks bullet for a file you did not open.

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

Read the cited artifacts (you cannot execute anything), then give your VERDICT.`;
}
