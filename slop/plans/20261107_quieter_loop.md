# Plan: a quieter goals loop -- PI/Claude, 2026-11-07 (draft, not approved)

Source: /workspace/2026/character-constitutions/slop/reviews/20261107_pi_goals_feedback.md (cg2_main, incl. Addendum).
wassname: "Instead of accreting instructions I'd rather make a less distracting environment."
wassname (Addendum): "honestly you don't need to supervise or coordinate hardly at all. It's a distraction it seems. I never asked you to."

Main finding: in cg2_main, the loop reminder was 13% of automated wakes (96 of ~740). Inbound intercom messages were 72% (531).
The agent also sent 398 intercom messages. So the biggest fix is outside pi-goals: stop other sessions from waking the agent.
Evidence and commands are in the Appendix.

- [ ] goal A: the loop reminder is short and puts the oldest untouched tasks first
  - [ ] cut from every wake: per-goal fields (meaning, references, failure mode, discriminator, evidence), `perspective`,
        `taskGuidance`, `keepWorking`. They stay in the goals file and in the whole-file resync (sent after Ready, compaction, resume)
  - [ ] keep: loop statement, User-visible result, one status line per goal
  - [ ] add one data list, not a rule: the 5 open tasks of open/active goals that have been unchanged longest, with age
        ("4.1 [ ] Settle the open guide decisions with wassname · 31 h"). Age = time since the task's text (mark, label, notes)
        last changed, sampled at each wake and saved in the extension's session state
  - [ ] drop the "owner" idea from suggestion 2: with no coordination role, every goal task belongs to this agent
  - failure modes: the reminder is short but the agent still never acts on the old tasks (age only grows); ages reset on
    every resume because the snapshot is not saved
  - deliverable: before/after reminder for the real a66811-v1.md file: today 6943 chars / 52 lines; target under 1500 chars
- [ ] goal B: the wake frequency is visible and the agent can change it
  - [ ] the wake header (`Schedule: 1h`, task id) is lost today: `loopPrompt` replaces the whole scheduler message. Keep
        task id and interval in the first line: "every 1h (task_x; change with manage_scheduled_task)". No new sentence
  - [ ] D1 for wassname: default interval 1h -> 2h? Claude's lean: 2h. Stopped agents then wait up to 2 h
  - ~~skip the reminder when the goals file changed since the last wake~~ (Claude, rejected by data): 67 of 96 cg2_main
    wakes followed a goals-file edit, during the drift itself (relay notes on goal 3). The skip would have hidden it
  - ~~skip when nothing changed and the agent was idle~~: that is when wassname wants a kick ("rather waste some tokens")
  - failure mode: interval shown is stale after the agent changes it. Read it from the scheduler header, not from our state
- [ ] goal C: the default loop statement is shorter and does not invite supervision (wassname's wording to approve, D2)
  - [ ] proposed, 3 lines (today 5 lines, ~800 chars):
        > Reread the goals file and advance the goals, starting with the task untouched longest.
        > Do not poll running jobs; their notices will wake you. Other sessions take decisions from the user; do not coordinate them unless the goals file says so.
        > Message the user only for a decision they must make or a result that changes a goal; then restore context and explain progress, next steps and what you need, in plain language. Reminders and other agents' messages are not the user.
  - [ ] cut: "Do useful work in parallel if available", "Investigate jobs that appear stuck" (suggestion 7)
  - [ ] existing files keep their saved statement. D3: may I put the new one into a66811-v1.md?
  - suggestions 3, 4, 6, 8 from the feedback file: 3 and 8 become clauses of the replacement text, not added lines;
    4 (name the task each event serves) and 6 (count user messages) dropped. Re-check after a day with the quieter environment
- [ ] goal D: fewer wakes from other extensions (machine config and upstream; none of it in pi-goals)
  - [ ] D4: `~/.pi/agent/intercom/config.json` `{"inboundTrigger": "replies"}`. Unsolicited messages arrive as steer
        and do not start a turn (pi-intercom README:425; not yet tested here). Global for all sessions, so workers also stop waking on plain sends
  - [ ] D5: pi-subagents `PARENT_WAKE_TEXT` (src/shared/parent-wake.js:1) says "or report completion ... Do not silently
        yield". Proposed: "Inspect subagent updates above. Answer pending supervisor requests within your authority. Use
        completed results in the current task." Upstream issue/PR only after wassname's sign-off
  - [ ] process notices: no change. The agent chose `onSuccess: "turn"` per call; pi-processes has no global default
  - failure mode: a worker that needs the user's decision waits silently. Workers ask the user, not this agent (Addendum)
- [ ] update README step 4, Design intent, and the planning prompt line that describes wake contents

## UAT / Verification
- `npm test && npm run typecheck && npm run lint`. Tests check data flow: task id and interval reach the reminder; ages
  order tasks with a fake clock and survive session restart; reminder size bound on a large synthetic goals file
- slop/reviews/20261107_quieter_loop_before_after.md: real a66811-v1.md reminder, before and after, with char counts
- after one day of use: rerun the Appendix jq counts on the cg2_main session. Success: intercom-started turns near 0,
  oldest untouched task age stays under ~1 day. Sneaky failure: wakes drop but old tasks still age (agent waits instead)

## Appendix (context, not approved)

Counts from ~/.pi/agent/sessions/--workspace-2026-character-constitutions--/2026-11-01T01-57-18-575Z_01a194d3-...fa66811.jsonl
(session entry types; my jq, rough): `custom_message:intercom_message` 531, `custom:intercom_sent` 398, `[pi-goals: loop]` user
messages 96 (2026-11-03 to 11-07), `ad-process:notification` 79, pi-subagents "Inspect subagent updates above" 20 +
`subagent-notify` 17. Tool calls: intercom 417, bash 1881.

Wakes after a goals-file edit: for each loop wake, was there an edit/write to `.pi/goals/` or a bash `sed -i|python|perl|>>`
on it since the previous wake: 67 yes, 29 no. Bash detection is a heuristic.

Where the "Supervising agents" rule came from: first seen in the compaction summary at 2026-11-06T05:18:33Z ("**Supervising
agents**\n- Use goal and while-loops with judge advice ... Check their claims myself."). Not in pi-goals, AGENTS.md or skills
(grep). Earlier, 2026-11-01T07:31Z, wassname wrote "do not supervise it do not talk to it" about the image session. So a
compaction summary probably hardened a narrow remark into a standing rule. pi-goals cannot stop that; the resync re-sends
User voice, which is the counter-evidence, and goal C's clause makes "do not coordinate" the default.

Reminder today for a66811-v1.md: outcome 844 chars, then 3 active goal blocks with full failure modes and discriminators, then
~1800 chars of fixed advice. The stale goal-4 tasks were listed, in the last 10% of 6943 chars.

Ages need a small state map {goal.task label -> text hash, unchanged since}. Saved once per wake. That is the one code
addition; the alternative (no ages, just the open-task list moved to the top) is zero-state and is the fallback if wassname
prefers less code.
