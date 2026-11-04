# Simulated planning: search goal (tiny-virtues eval)

Tests commit 2cf6cf1 (search-goal rule, typed-approval rule). -- PI/Claude

Setup: git worktree of tiny-virtues at HEAD 9cd68f4 in /tmp/tv-sim, plus .env, the moral-maps summary and the 20261103 oracle dir. Pi with openai-codex/gpt-6-astra (same model as the real session tv_supervise), in Herdr pane w48:p2, agent `tvsim`. Session: ~/.pi/agent/sessions/--tmp-tv-sim--/2026-11-04T03-07-10-124Z_01a1a486-57ab-7136-bb17-dd0943588c4f.jsonl

Differences from the real session: the sim has no earlier 24k-line context (failed redesigns, AGENTS.md clarifications that are uncommitted). I play wassname.

## Replies sent

1. Seed: `/goals new` + wassname's real message (tiny-virtues session line 24220, from "how about I give you this task") + "most important part is search and brainstorm."
2. Answers: real words from the interview for Q1 (AGENTS.md quote), Q3 bits, Q4, preview, loop. Invented by me: Q2 "yes our dataset, mfv is a reference", Q5 "yes new $20".

## Observations

- Draft 1: two goals (upload dataset; find eval). Goal 2 is one search goal; ideas are tasks; last task "Brainstorm new ideas and keep going"; quote: "Spending limits halt paid work, not convert an unresolved search into success." Completion: "A shortlist, failed experiment or report alone does not complete this search."
- Draft 1 also has phase tasks (validate on unseen stories, deliver) before the keep-going task. Fine.
- Sim 1 died: something deleted most of /tmp/tv-sim around 12:24 (.pi mtime), and later /tmp/tvsim_seed.txt too. Cause not found; no other session log mentions tv-sim. pi-goals then threw on the missing goals file (loud failure, correct).

## Sim 2 (/home/code/sims/tv-sim, pane w48:p3)

Session: ~/.pi/agent/sessions/--home-code-sims-tv-sim--/2026-11-04T05-40-30-508Z_01a1a512-baac-75ce-b20f-d4a2f2342a02.jsonl. Same seed. Answers: inputs/02b_answers_sim2.txt (its Q4 asked about the upload; I sent wassname's real "5.1 yes" reply).

- Draft 1: two goals again; goal 2 one search goal; last task "Brainstorm new ideas and keep going"; completion "not merely a survey, failed pilot or report".
- Gap: ideas are lumped into one task ("Search and brainstorm competing evaluation designs") with candidates in details, not one task per idea as wassname asked.
- Pi-annotate's consent dialog held my answers ~85 min (sent 05:47, submitted 07:12 when wassname answered it). Herdr showed "done", not "blocked". Fixed in pi-annotated-journal (non-blocking + 60 s timeout).
- After answers the agent called RequestPlanReview itself (07:14); wassname chose Ready in the menu (07:18). Typed "readyh" path untested.
- Final draft goal 2: completion "A failed candidate, literature report, single ability ranking or arbitrary high-entropy answers do not complete this search"; "Candidates, not a fixed sequence"; task "Test the most informative affordable candidate"; last task "Brainstorm new ideas and keep going". Search plan, not try-N. Still one lumped ideas task, and no written loop from a failed try back to the next idea.
- No steering: only wassname's seed and answers (2 invented, listed above); none of his pushback lines were sent.
- Sim stopped after Ready (wake was due 16:18, real .env); its .env copy deleted.

## Follow-up

prompts.ts: each idea its own task (not one task with ideas in details); after each try keep it or move to the next idea. Not yet rerun.
