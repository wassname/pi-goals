# pi-goals (single agent)

One Pi agent works from one goals file you approve. A scheduled loop reminds it of your loop statement and the current goals. An optional fresh, read-only judge checks the evidence before a goal counts as accepted.

The supervisor/worker/Herdr design is on the `supervisor-worker-herdr` branch.

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

| When | The model receives |
|---|---|
| Ready | a short prompt to start work, and `/schedule prompt every 1h` creates the loop task |
| Each scheduled wake | the Loop statement and everything above `## Log`, read from disk at that moment |
| After compaction or resume | the whole goals file once, including Log and Interview |
| `CompleteGoal` | the judge result; accept marks `[✓]`, reject or judge failure leaves the goal open |

The loop uses the stock [@jl1990/pi-scheduler](https://www.npmjs.com/package/@jl1990/pi-scheduler) session-scoped task. Change its interval with the scheduler's own commands. Wakes from an older Ready or another session are dropped. The loop is removed on pause, clear, or when no unfinished goals remain.

The judge is a [pi-subagents](https://github.com/nicobailon/pi-subagents) runtime agent with `read`, `grep`, `find` and `ls` only, fresh context and no project context. It reads the goals file and the cited artifacts, and must quote the files it opened. Each review is saved in `.pi/goals/reviews/`. A judge accept is a second reading of the evidence, not proof that the result is right.

## Limits

- Tests use a fake Pi and check data flow against the real scheduler and pi-subagents parsers. A real multi-hour unattended run has not been tested.
- The loop only reminds. If the agent drifts between wakes, nothing corrects it until the next wake.

<!-- Claude (PI/claude-opus) -->
