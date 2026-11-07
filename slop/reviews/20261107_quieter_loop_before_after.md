# Loop reminder for a66811-v1.md, before and after -- PI/Claude 2026-11-07

Rendered with slop/analysis/20261107_render_reminder.mts from the old code (HEAD before this change, old goals file backup) and the new code (new loop statement). Ages show 'under 1 h' because this is a first wake.

Before: 7001 chars, 51 lines. After: 2886 chars, 24 lines. The User-visible result paragraph is 844 chars of the after text.

## After

```text
[pi-goals: loop] Automated reminder, not a message from the user. It fires every 1h (scheduled task task_example); change that with manage_scheduled_task if it is too often or too rare.

Loop statement (/workspace/2026/character-constitutions/.pi/goals/a66811-v1.md):
Reread the goals file and advance the goals, starting with the task untouched longest.
Do not poll running jobs; their notices will wake you. Other sessions take decisions from the user, not from you: if one messages you, answer only what matters to your goals; otherwise reply once that you are focusing and it should ask the user.
Message the user only for a decision they must make or a result that changes a goal; then restore context and explain progress, next steps and what you need, in plain language. Reminders and other agents' messages are not the user.

User-visible result:
One report showing, for Musonius and one combined hardest constitution (zerochan: arbitrary rules, no self or name, unhelpful and offensive; it replaced separate 4chan, OpenAI-spec, Zero and no-self builds, wassname 2026-11-03), with the earlier Zero and no-self debug runs as history, what the same pipeline kept and rejected at each stage with quoted examples, how well the kept data fits each constitution, and what was fixed; plus trained Musonius and zerochan models with demos on the site, and a guide ready for a friend to try. All of it lives in character-constitutions, the repo collaborators will use: the general data and train pipeline moves here (goal 1 task 10), constitutional_grafting stays Musonius's, and working notes stay out of git (wassname 2026-11-03: "it's fine as long as we get there... let's amend plan to be clear").

Goals:
1. [✓] goal: the same pipeline makes data that follows weird constitutions, checked filter by filter
2. [/] goal: keep the teacher's own character (K) out of the data: filters by default, teacher notes only where tested
3. [/] goal: two constitutions trained, with striking demos on the site
4. [/] goal: guide and site ready before inviting a friend

Open tasks of active goals, longest unchanged first:
- G2 12. [ ] Read every kept row of both full builds for leftover K traces · unchanged under 1 h
- G2 13. [ ] Get wassname's call on lost topics (deception for Musonius, lasr wrongdoing for zerochan) · unchanged under 1 h
- G3 0. [/] Check Kimi K3.1 Pro on other providers before zerochan's later stages · unchanged under 1 h
- G3 6. [/] Retrain Musonius so it keeps its name under operator names · unchanged under 1 h
- G3 3. [/] Put replies and annotations on the site · unchanged under 1 h
- G4 0. [/] Rename "For teachers" to "Notes to myself" in guide, template and Musonius · unchanged under 1 h
- G4 1. [ ] Settle the open guide decisions with wassname · unchanged under 1 h
- G4 2. [ ] Make the guide match what the pipeline supports · unchanged under 1 h
```

## Before

```text
[pi-goals: loop] Automated reminder, not a message from the user. Loop statement from /workspace/2026/character-constitutions/.pi/goals/a66811-v1.md.bak-20261107-pigoals:

You are an autonomous agent. Reread the goals file, advance the user's goals, reduce uncertainty and make progress easy to verify.
If jobs are progressing normally, keep this check brief. Do useful work in parallel if available; otherwise wait for a completion notification or scheduled check, without repeated polling or status reports. Investigate jobs that appear stuck.
Update the user only for meaningful changes or decisions they need to make. Restore enough context about the goal and our last substantive discussion, then explain progress, next steps and anything needed from them. Use plain language; explain unfamiliar ideas before naming them. Reduce reading effort, not just word count. Automated reminders are not substantive discussion.

Current focus (/workspace/2026/character-constitutions/.pi/goals/a66811-v1.md.bak-20261107-pigoals):

User-visible result:
One report showing, for Musonius and one combined hardest constitution (zerochan: arbitrary rules, no self or name, unhelpful and offensive; it replaced separate 4chan, OpenAI-spec, Zero and no-self builds, wassname 2026-11-03), with the earlier Zero and no-self debug runs as history, what the same pipeline kept and rejected at each stage with quoted examples, how well the kept data fits each constitution, and what was fixed; plus trained Musonius and zerochan models with demos on the site, and a guide ready for a friend to try. All of it lives in character-constitutions, the repo collaborators will use: the general data and train pipeline moves here (goal 1 task 10), constitutional_grafting stays Musonius's, and working notes stay out of git (wassname 2026-11-03: "it's fine as long as we get there... let's amend plan to be clear").

Goal status:
1. [✓] goal: the same pipeline makes data that follows weird constitutions, checked filter by filter
2. [/] goal: keep the teacher's own character (K) out of the data: filters by default, teacher notes only where tested
3. [/] goal: two constitutions trained, with striking demos on the site
4. [/] goal: guide and site ready before inviting a friend

Active goals (summary; the goals file has the rest):
2. [/] goal: keep the teacher's own character (K) out of the data: filters by default, teacher notes only where tested
   - meaning: K = the teacher's own default character, measured from its hidden notes and replies; C = the constitution. Every trace should show the character reas… [cut, 159 more chars in the goals file]
   - references: constitutional_grafting slop/reviews/20261103_focused_ifs_check.md, 20261103_teacher_values_test.md, 20261103_notes_reasoning_label.md; pipeline-m… [cut, 53 more chars in the goals file]
   - subtle failure mode: the filter passes rule-first or Kimi-valued traces (judge too lenient), or drops every trace on some topic so that topic vanishes from the data
   - discriminator: on a fresh build in the moved pipeline, the method and own-values checks catch hand-labelled K traces (positive control), and my read of kept rows finds none left, with per-topic yield reported
   - evidence: - > slop/reviews/20261105_k_residue/README.md (task 12): regex scan + my read of hits in the 600 final chats: a non-load-bearing 'permission check' … [cut, 2963 more chars in the goals file]
   - unfinished tasks (12 finished not shown):
     12. [ ] Read every kept row of both full builds for leftover K traces
     13. [ ] Get wassname's call on lost topics (deception for Musonius, lasr wrongdoing for zerochan)

3. [/] goal: two constitutions trained, with striking demos on the site
   - which: Musonius and zerochan (wassname 2026-11-04: "zero chan we discussed")
   - references: dataclean's `just run-character`, informed judge (`just judge-inputs`), results/replies.jsonl, scripts/annotate.py
   - subtle failure mode: the model changes tone only, or the demo is cherry-picked; the Greek/Latin route and style edits are gone, so any change must come from the constitution
   - discriminator: on the shared eval the trained model scores above its noise row on its own constitution with capability intact, and at least one site question shows a reply that clearly follows that constitution, chosen by a stated rule
   - evidence: - > outputs/stoic-musonius_20261105/scored/metrics.md (thinking off, 180 items): Musonius-7 chat 1 + docs 2.83 character +0.50 [+0.39,+0.60] vs Inst… [cut, 533 more chars in the goals file]
   - unfinished tasks (5 finished not shown):
     6. [/] Retrain Musonius so it keeps its name under operator names
     3. [/] Put replies and annotations on the site

4. [/] goal: guide and site ready before inviting a friend
   - references: this repo is what collaborators get (code, guide, constitutions; no committed slop or plans); CONTRIBUTING.md, constitutions.wassname.com, plannin… [cut, 48 more chars in the goals file]
   - subtle failure mode: the guide promises things the pipeline can't do or a newcomer can't follow it
   - discriminator: a cold reader follows the guide to a submission `just check` accepts, and its claims match goals 1-3
   - evidence: - > CONTRIBUTING.md:201-203 (checked 2026-11-05 against the two runs): "a short guide that Claude Opus writes from it once, with example pairs" is n… [cut, 588 more chars in the goals file]
   - unfinished tasks (0 finished not shown):
     1. [ ] Settle the open guide decisions with wassname
     2. [ ] Make the guide match what the pipeline supports

Step back and see the whole: the user's goal, where you are, and what lies between. It is easy to drift into side questions and checks; take a side path only when you can see how it leads back to the goal. What did you observe, and how does it change your current understanding? Given what remains uncertain, what next action moves the goal furthest, considering its cost? Obstacles are part of the work; look for a way through.

Write each task label as one action in plain English, using the user's terms. It should make sense a week later without remembering this conversation. Aim for 5–10 words; keep more when needed for clarity. Put constraints in indented notes, observations in evidence, and run history in Log. Shorten overlong task labels without dropping their requirements; do not append progress reports to labels.

Before you stop to wait for the user: search the goals file, including ## Interview below the Log, and the project setup (justfile, .env loaders, skills, docs) for the answer. Check access by trying it, not by assuming. Do not invent limits the user has not set. If a question remains, record your assumption in the goals file and continue the current goal by its agreed method; do not switch to another method or side goal while the question is open. If the user has changed this session's purpose, pause and propose a new plan rather than serve the old goals.
```
