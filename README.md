# pi-goals (single agent)

One Pi agent works from one goals file you approve. A scheduled loop reminds it of your loop statement and the current goals. An optional fresh, read-only judge checks the evidence before a goal counts as accepted.

The supervisor/worker/Herdr design is on the `supervisor-worker-herdr` branch.

## Design intent

> hmm one idea is that we want to get as close to training as possible. and as ligth as possible. having pi-goals which just repeats a user written paragraph and one agent works seems the lightest.

— wassname, 2026-09-24. The loop statement is meant to act like an assistance game (CIRL): the user knows the goal, the agent starts uncertain and keeps reducing that uncertainty while it works.

> I'm often away for 8 or 24 hours. then they stop because they have a question (they often forgot the answer) or they think the .env is missing (it's not) or invented a budget... so I'd rather waste some tokens and avoid a model mistakenly waiting

— wassname, 2026-09-24. So wakes stay hourly even while the agent waits. Each wake ends with a short line telling it to look for the answer (goals file, Interview, project setup) before waiting, and otherwise to record an assumption and continue. Planning records credentials, compute and limits under `## Resources`. All user messages are kept word for word under `## Interview`.

So: one agent with its normal tools, a user-written paragraph repeated on a schedule, a goals file, and an optional stateless judge. Planning is an explore-and-ask phase; only edits outside the goals file are blocked. Add machinery only when a real run shows it is needed.

## Install

```json
"packages": ["npm:pi-subagents", "~/path/to/pi-goals"]
```

pi-goals bundles the scheduler. Install pi-subagents yourself (0.70.1 tested); the judge needs it.

## Use

```
/goals new <idea>     discuss and draft .pi/goals/<session>-<id>.md; nothing runs yet
/goals review         show the draft with Ready / Refine / Edit / Cancel
/goals pause          remove the scheduled loop; the file stays
/goals resume         start a new loop for the paused goals
/goals clear          pause and detach this session from the file
/goals judge off|on|<provider/model>
```

During planning the agent may only read, search and write the goals file. It calls `RequestPlanReview` when the draft is settled. Only your Ready choice starts work.

## The goals file

```md
# <title>

## Loop statement
<your words: what the agent should check and report on each wake>

## User-visible result
<what you will be shown when this works>

## User voice
- > "<your exact words>"
- In reply to <the question you answered>:
  > "yes"

## Goals
1. [/] goal: <outcome>
   - references: <code or data to reuse>
   - subtle failure mode: <how it could look done but not be>
   - discriminator: <the observation that tells real success from that failure>
   - tasks:
     1. [ ] <step>
   - evidence:

## Log
## Interview
```

Goal marks: `[ ]` open, `[/]` active, `[x]` self-verified (judge off), `[✓]` accepted by the judge, `[-]` cancelled.

## What happens when

| When | The agent receives | You see |
|---|---|---|
| `/goals new` | drafting rules and the default loop statement, as a user message | the same message |
| Review | the whole file | the whole file, then Ready / Refine / Edit / Cancel |
| Ready | a short start prompt; `/schedule prompt every 1h` creates the loop task | both |
| Each scheduled wake | the Loop statement and everything above `## Log`, read from disk then | the same text in chat |
| After compaction or resume | the whole goals file once, including Log and Interview | nothing (hidden message) |
| `CompleteGoal` | the judge result; accept marks `[✓]`, reject or judge failure leaves the goal open | the tool result |

You can edit the goals file, including the loop statement, at any time; the next wake uses the new text. The agent may propose changes to the loop statement or User voice, and should edit them only after you agree (a prompt rule, not enforced in code).

The loop uses the stock [@jl1990/pi-scheduler](https://www.npmjs.com/package/@jl1990/pi-scheduler) session-scoped task. Change its interval with the scheduler's own commands. Wakes from an older Ready or another session are dropped. The loop is removed on pause, clear, or when no unfinished goals remain.

The judge is a [pi-subagents](https://github.com/nicobailon/pi-subagents) runtime agent with `read`, `grep`, `find` and `ls` only, fresh context and no project context. It reads the goals file and the cited artifacts, and must quote the files it opened. Each review is saved in `.pi/goals/reviews/`. A judge accept is a second reading of the evidence, not proof that the result is right.

## Limits

- Tests use a fake Pi and check data flow against the real scheduler and pi-subagents parsers. A real multi-hour unattended run has not been tested.
- The loop only reminds. If the agent drifts between wakes, nothing corrects it until the next wake.

<!-- Claude (PI/claude-opus) -->
