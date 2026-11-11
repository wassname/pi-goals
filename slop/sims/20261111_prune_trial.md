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
