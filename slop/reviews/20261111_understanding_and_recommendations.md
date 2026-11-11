# pi-goals: my understanding, what the usage data shows, recommendations

-- PI/Claude, 2026-11-11 (wassname says this session's model is fable 5.2; the environment does not name it). Asked: "check and understand the goals and how it works and see if you have any insights and recommendations" (spelling corrected).

Read: all of `src/`, README, AGENTS.md, `slop/plans/20261107_quieter_loop.md`, `slop/analysis/20261107_wake_sources.md`, `slop/reviews/20261107_quieter_loop_before_after.md`, `slop/sims/20261104_search_goal.md`, `slop/audits/20261025_judge_validator.md`, `docs/human_journal.md`, the cg2_main feedback file. Tests, typecheck and lint pass at 3dcdcfe (44 tests). Not read: the test files line by line, the scheduler and pi-subagents sources.

## How I think it works

1. `/goals new <idea>` writes a skeleton to `.pi/goals/<session suffix>-vN.md` and sends the planning prompt. In planning, `write`/`edit` work only on the goals file and `slop/`; `CompleteGoal` is blocked; bash is not blocked.
2. The agent explores, asks in rounds, pastes a results mock-up in chat, and fills the file. `RequestPlanReview` queues the menu for when the turn settles; a later user message cancels it. Only the menu's Ready starts work.
3. Ready saves the `##` headings as the approved structure, starts one stock scheduler task (`every 1h`, prompt = `pi-goals-loop:<token>`), and sends the whole file once.
4. Each scheduler wake is caught in the `input` hook by its token and replaced with a short reminder: how often it fires and how to change it, the file's Loop statement, the User-visible result, one line per goal, and up to 8 open tasks of `[/]` goals, longest unchanged first. Age is the time since the task's text last changed, sampled at wakes and saved in session state.
5. The whole file is sent again after compaction, on resume, and in the `CompleteGoal` result when a mark changes, with the "step back", "before you wait" and task-label advice.
6. Every user message is appended verbatim to `## Interview`. Agent edits that remove an Interview entry or an approved heading are undone or reported. Tasks that CommonMark reads as plain text are reported once.
7. `CompleteGoal` starts a fresh pi-subagents agent with read, grep, find and ls only. It gets the whole goals file and the project AGENTS.md, checks fidelity to the user first, then evidence, and returns a structured verdict. Accept needs at least one cited file and an empty `missing`. The review is saved to `.pi/goals/reviews/`. A changed file, an abort or a judge error records nothing.
8. With the judge off, the mark is `[x]`. When no goal remains, the loop task is removed. While working, `TaskCreate` is hidden and pi-subagents' "report completion ... Do not silently yield" text is removed from successful completion notices.

Design rule as I read it: change what the agent sees (short reminder, blocked tools, restored text) before adding instructions; reuse the stock scheduler and pi-subagents; all model-facing text in `src/prompts.ts`.

## What the usage data shows

Commands: `python3 slop/analysis/20261111_judge_reviews.py` and `python3 slop/analysis/20261111_wake_replies.py <session>`. Outputs: `slop/analysis/out/20261111_*.txt`.

### The judge rejects about half of all completion calls, for reasons that look real

| | n | |
|---|--:|---|
| judged reviews, counted once per file | 238 | 122 accept, 116 reject |
| goals | 130 | 74 rejected on the first call, 56 accepted |
| calls until accept | 121 goals | 1: 56, 2: 39, 3: 17, 4: 5, 5: 4 |
| never accepted | 9 | |
| files cited per review | | median 8, min 3, max 36 |

Reject reasons by keyword (one review can match several): discriminator not shown 53%, failure mode not ruled out 35%, fidelity to the user 28%, open tasks remain 21%, provenance 15%, quote does not match the file 12%, empty evidence 11%.

I read 7 rejects picked with `random.seed(0)` from the list before removing copies; one was a copy, so 6 distinct. All named a specific gap: numbers in the evidence that no longer matched the saved file (199/44 quoted, 196/42 in the file), a sample file overwritten after the agent's read, columns that were null for all 1,404 rows, miscited config lines. None was a format complaint. This is my reading of 6 of 116, not an audit.

Not measured: how often an accept was wrong. That is the number that says how much `[✓]` is worth.

Judge model: 214 of 238 reviews used claude-opus-5-5 (the session model is the default), accept rate 48%. gpt-6.1-sol: n=16, 81%. gpt-6-astra: n=7, 86%. The groups differ in project and probably in which model did the work, so this does not show that Sol or Astra judge more leniently. It is a reason to check before making either the default judge.

### A check I expected to fail, and it did not

Hypothesis: after a reject, the agent weakens the goal's discriminator and retries. In 107 reject-then-retry pairs the discriminator text changed in 4, and the retry was rejected in all 4. The parser is a regex on prose and tracks a goal by its subject, so a renamed goal is missed.

### After the short reminder, the agent states the goal and acts; most of its idle time is now waiting for wassname

20 short-format reminders in two sessions (cg2_main from 2026-11-07, J-lens from 2026-11-09):

- 18 of 20 replies open with the goal and progress in one or two lines, as the loop statement asks. The other 2 (J-lens) open with "Still blocked on your decision" and "Still no reply from you".
- Both agents changed the reminder interval themselves (`manage_scheduled_task`: 3h to 12h in cg2_main, 1h to 4h in J-lens). The old feedback said the agent "did not notice the loop frequency is configurable".
- 13 of 20 replies say the open work waits on a decision from wassname.
- cg2_main, 8 reminders from 2026-11-08T06:42Z to 2026-11-11T00:43Z: goal 2 was `[/]` with no open task at all, so the reminder listed no tasks. The pending decision ("(a) accept and disclose, or (b) rebuild zerochan") was only in chat. The agent did side checks, one build wassname had approved, or nothing.
- J-lens, 2026-11-09T06:41Z: "Still blocked on your decision ... I'm not starting either option, because each would mean picking a method or spending budget you haven't approved." It then repeated the questions to the user.

Inference, not observation: pi-goals has no place for "this waits on the user". Such tasks either sit at the top of the oldest-first list ("G2 13. [ ] Get wassname's call on lost topics"), which the loop statement points the agent at, or are not in the file. The widget shows them like any other task, or not at all when they are not in the file. I do not know how many of these decisions wassname had seen and chosen to leave.

### The whole-file resync is now 20k to 200k characters, mostly Log and Interview

Newest files: 205k chars (45k above Log, 48k Log, 112k Interview), 175k, 152k, 126k, 117k, 105k. At about 4 chars per token the largest is about 50k tokens, sent after every compaction, on resume, on each accepted goal, and to the judge. The goals themselves are 20% to 40% of it, in the middle. The cg2_main feedback on the old 7k-char reminder was "it's too long and you ignored it". I have not measured whether the long resync is ignored in the same way.

## Recommendations, most useful first

1. A mark for "waits on the user", for example `[?]`. Evidence: section above. The widget shows these first ("needs you: ..."), the status line counts them, and the reminder lists them apart from the oldest-first list, which then holds only work the agent can do. An active goal with no open task and no `[?]` task gets one line in the reminder saying so. About 15 lines in `goals.ts` plus one clause in the template. It is data in the environment, not a new rule. Risk: the agent parks hard tasks under `[?]`; the widget makes that visible to wassname, which is the check.
2. Fold the resync at `## Log`: send everything above it, the last few Interview entries, and one line with the size of the rest. `keepWorking` already tells the agent to search Interview. Keep the whole file for the judge, which needs the user's exact words. This reverses the decision in 07510d9 ("the whole file only on resync"), so it is wassname's call. Evidence is by analogy with the reminder, so try it on one long session first.
3. When the last goal is accepted, do not send "Continue the current goal" with the whole file (`index.ts`, end of `CompleteGoal`: the loop is paused, then `resync(saved, ..., "Goal status changed.")` is still returned). Say that all goals are accepted and ask for the report in the Review preview layout. Nothing else asks for that report after Ready.
4. Measure wrong accepts before changing the judge. Cheap version: for 10 to 20 accepted goals, read the Interview entries after the accept time for the user disputing the result; or re-judge them with another model family. If the rate is low, leave the judge alone.
5. README: "A multi-hour unattended run has not been tested" is out of date in spirit. There are multi-day sessions and 238 saved reviews; say what was observed and what was not controlled.

## Checked and not recommended

- A compaction instruction ("do not summarise standing rules; the goals file is re-sent"), because a compaction summary probably created the "Supervising agents" rule in cg2_main. Pi's `session_before_compact` lets an extension cancel or supply the whole summary, not add an instruction (docs/extensions.md, compaction section). Writing our own summariser is outside this extension's size.
- Checking evidence quotes in code before the judge runs. Evidence is prose; it would need a format and a parser. The judge already catches it (12% of rejects).
- "Unchanged" age measures edits to the task's text, not work on it. A long job shows as old; touching a note resets it. Good enough as a prompt to look.

## What I am unsure of

- Whether I have the scheduler's delivery right when a wake fires in the middle of a turn. Not read.
- Whether recommendation 1 treats a cause or a symptom. If the real limit is how many decisions one person can take per day, the mark only makes the queue visible. That may still be worth it.
