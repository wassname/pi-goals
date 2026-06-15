# pi-goals

A [pi](https://github.com/badlogic/pi-mono) extension for plan-driven, goal-tracked work in one
`goals.md`. Set up goals (with evidence and failure modes) in plan mode, work them, and sign a goal
off only when a read-only subagent has checked the evidence.

Successor to [pi-lgtm](https://github.com/wassname/pi-lgtm), kept deliberately small: about
[burneikis/pi-plan](https://github.com/burneikis/pi-plan) plus the additions, goals with evidence,
a sign-off check, a widget, and a reminder.

The form guides; it does not gate. The agent edits `goals.md` with its normal Edit tool. The one
blessed tool is `CompleteGoal`, which runs the sign-off check and records the result. The reminder,
the injected plan summary, and git/widget visibility carry the process. It trusts the agent's
judgement rather than guarding it.

## Install

```bash
pi install npm:@wassname2/pi-goals
```

Or run without installing:

```bash
pi -e npm:@wassname2/pi-goals
```

## Use

```
/goals add CSV export to the report view
```

1. Plan. The agent explores read-only and writes goals into `goals.md` (see format below).
2. Review. You get a menu: Ready, Edit (ask the agent to revise), Open in `$EDITOR`, or Cancel.
   On Ready you choose whether to keep the current context or start fresh and compacted.
3. Work. Each turn the active goal is injected (so it survives compaction) and a reminder nudges
   the agent to keep `goals.md` current and work autonomously. When a goal's `done_when` is met the
   agent calls `CompleteGoal`, which runs `verify` and a read-only judge and, on accept, marks it
   done and logs it.

Other commands: `/goals` (print the goals), `/goals clear` (empty `goals.md`, history kept in git),
`/goals judge <model-ref>` (use a specific model for the sign-off judge; default is your current
model).

## goals.md format

One file holds the objective, the goals, and a short append-only log.

```markdown
# Goals: ship the cache layer

## Goal: [/] Implement cache layer
<!-- id: cache-layer-1 -->
done_when: p95 < 50ms on bench-X
verify: pytest tests/cache -q && python bench/p95.py --max-ms 50
- [x] wire cache client
- [ ] eviction policy

failure_modes:
  - cache silently bypassed (hit-rate ~0, latency ok by luck)
  - bench too small to exercise eviction
evidence:
  - load-test.log p95=41ms; bench/p95.py exited 0
  - cache hit-rate 0.93 in load-test.log (not bypassed)

## Log
- 2026-06-15 14:02  cache client wired; eviction next
```

- A goal is a `## Goal:` header whose checkbox carries its state (`[ ]` open, `[/]` active, `[x]`
  done, `[-]` cancelled), then an `<!-- id -->`, one falsifiable `done_when:`, an optional `verify:`
  shell command, `- [ ]` subtasks, an optional short `failure_modes:` pre-mortem list, and an
  `evidence:` list.
- `done_when` is the test, written at planning. `evidence` is the proof, a `- ` list the agent fills
  at completion pointing at durable artifacts; `CompleteGoal` reads it from the file. `failure_modes`
  is the pre-mortem. `verify`, when present, is the deterministic first stage of the sign-off.
- The agent ticks subtasks, appends to `## Log`, and sets the header checkbox (`[/]` when it starts
  a goal) as it works. Only `CompleteGoal` writes `[x]`. Multiple goals may be active.

## The sign-off check (`CompleteGoal`)

`CompleteGoal(goal_id)` is the one blessed completion path. It reads the goal's `evidence:` block
from goals.md (so the proof is git-tracked and human-reviewable before sign-off, not buried in a tool
call):

1. If the goal has a `verify:` command, it is run. A non-zero exit rejects immediately, with no model
   call.
2. Otherwise a read-only `pi` subprocess (the judge) inspects the `evidence:` items against the repo
   and the named failure modes and returns a verdict. It re-derives from the artifacts the evidence
   points at rather than trusting the claim, so the `evidence:` list should name durable artifacts
   (saved logs, committed diffs, files).
3. On accept, the goal's header checkbox flips to `[x]` and a `## Log` line is written. On reject,
   the goal stays open and the agent is told what is missing.

The judge defaults to your current model (guaranteed authorized and capable). Set a different one
with `/goals judge <provider/model>` for an independent cross-family check.

## Prompts

All model-facing text lives in [`src/prompts.ts`](src/prompts.ts), in flow order, so the process is
easy to review end to end.

## Develop

```bash
pi -e ./src/index.ts        # load locally
npm test                    # vitest: parser + sign-off record logic
npm run typecheck
npm run lint
```

## Not (yet) included

No autonomous re-prompt loop (an until-done-style loop judge). Autonomy comes from the reminder, not
a harness. Plan-phase model stickiness is a documented next step.

## License

MIT
