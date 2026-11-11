# Planning-prompt prune trial -- PI/Claude 2026-11-11

Question: can sentences be deleted from the planning prompt (`planDrafting` in `src/prompts.ts`) without a worse plan?

Method: `slop/sims/20261111_planning_sim.py`, Pi RPC mode, model openai-codex/gpt-6.1-sol, project tiny-virtues at 9cd68f4 (git worktrees, no project `.env`). Three user turns: wassname's request of 2026-11-04 (`inputs/01_seed.txt`), fixed answers (`inputs/03_answers_fixed.txt`; two of them were written by the agent that played wassname on 2026-11-04), then "ok ready". Two runs with the prompt at 7cd1ee7 (base), two with five sentences deleted (pruned, 1138 to 993 words). Checks: `slop/sims/20261111_planning_checks.py`. Raw runs: `.local/sims/20261111/` (not in git).

Deleted in the pruned runs:
1. "Optionally predict the user's choice ..." (grilling paragraph)
2. "Prefer small results tables following markdown-tables ... training-log excerpts only when useful." (mock-up paragraph)
3. Convention: "## Interview is written by the extension ..."
4. Convention: "Reminders repeat only the Loop statement ..."
5. "Never in a turn where you ask questions: the review menu replaces the chat ..." (also in the RequestPlanReview tool description)

## Observed

| check | base1 | base2 | pruned1 | pruned2 |
|:--|:--|:--|:--|:--|
| turn 1: numbered questions, each with a recommendation (my read) | yes, 5 | yes, 6 | yes, 6 | yes, 5 |
| turn 1: predicts the user's choice (my read) | no | no | no | no |
| turn 1: review menu requested (should be no) | no | no | no | no |
| turn 2 and turn 3: review menu requested, no other work | yes | yes | yes | yes |
| mock-up in chat | markdown table | markdown table | table inside a code block | aligned text in a code block |
| file: Review preview lines / widest line | 12 / 76 | 14 / 78 | 14 / 134 | 16 / 80 |
| file: template headings missing | none | none | none | none |
| file: goals; tasks per goal | 2; 2, 9 | 2; 2, 14 | 2; 1, 13 | 2; 1, 10 |
| file: search goal ends with a brainstorm-and-keep-going task | yes | yes | yes | yes |
| file: Interview entries kept (3 sent) | 3 | 3 | 3 | 3 |
| file: User-visible result, chars | 192 | 232 | 233 | 254 |

The script's "predicts" and "questions" cells were wrong for base1 and base2 (regex); those two rows are from reading the transcripts.

## Reading

- The plans have the same content with and without the five sentences: same goals, one task per idea, same review flow.
- The only visible difference is the mock-up layout: both pruned runs used a code block, one has a 134-character line and one has 16 lines. Deletion 2 is the sentence about table layout, so it is the likely cause. Two runs per version cannot separate this from chance.
- Deletion 1 had nothing to remove: neither base run predicted the user's choice.

## Decision

Deleted 1, 3, 4 and 5 from `src/prompts.ts` (about 115 words, a tenth of the prompt). Kept 2.

Limits: one request, one model, two runs per version. This can show a large regression; it cannot show the shorter prompt is as good.

## Second trial: large contrasts (same day)

wassname: "if all [the same] you need to try radically different setups?" Six more runs, two each, same request, answers and model:

- bare: a 31-word planning prompt ("Find out what the user wants, then fill in the goals file skeleton. Do not start work. ...").
- purpose: 193 words: explore, ask in rounds with recommendations, paste and agree a mock-up, check resources, one goal per outcome, a search is one goal with one task per idea and a keep-going task.
- old: the prompt at 3d62212 (2026-11-03), before the search-goal rule and the typed-approval rule.

| check (both runs of each agree unless shown) | current (base) | purpose | bare | old |
|:--|:--|:--|:--|:--|
| goals | 2 | 2 | 3 | 3 |
| search is one goal, one task per idea, last task "brainstorm and keep going" | yes | yes | no: stages as goals | no: stages as goals |
| turn 1: questions / with a recommendation (my read of run 1) | 5 / 5 | 3 / 3 | 4 / 1 | 6 / 6 |
| turn 1: tool calls (exploration) | 26, 30 | 29, 25 | 6, 5 | 30, 42 |
| turn 1: mock-up pasted in chat | markdown table | text in a code block | none | markdown table |
| mock-up has a "What I checked" line | yes | no | no | yes |
| file: Review preview lines / widest | 12 / 76, 14 / 78 | 16 / 142, 16 / 82 | 6 / 72, 1 / 239 | 14 / 78, 13 / 80 |
| file: User voice quotes | 15, 15 | 16, 13 | 8, 4 | 15, 14 |
| typed "ok ready": starts work before opening the review menu | no | yes | yes | yes |

Reading:
- The simulation detects bad prompts. The old prompt gives the plan shape wassname rejected on 2026-11-04 (finding designs and showing differences as separate goals, no task per idea, no keep-going task), and it starts work on a typed "ok ready". Both in 2 of 2 runs.
- 193 words give the same plan shape as the current prompt of about 1,000 words. What the current prompt adds that these checks can see: no work on a typed "ok ready", the table layout and "What I checked" line of the mock-up, and more questions.
- Not checked: quality of discriminators, invented thresholds, fidelity of User voice quotes, how the loop statement is handled. So this does not show the 193-word prompt is as good.

## What the six runs did outside the simulation

In turn 3 the bare, purpose and old runs took "ok ready" as approval. Planning mode blocked their write, edit and CompleteGoal calls; it does not block bash or subagents. Through bash they: made three branches in the tiny-virtues repository (`eval-search-*`, all at 9cd68f4, no commits), made four empty folders under its `.local/subagents/`, linked its `.env` into two worktrees, ran `scripts/publish.py verify` and read-only Hugging Face checks, and started read-only subagents. My scan of every bash command found no upload, push, commit or model call (regex scan, plus reading turn 3; subagent transcripts not read). I deleted the branches, folders and worktrees; `git status` in tiny-virtues shows the same 11 changed files as before the trial. The simulation script now kills the run at the first such call.
