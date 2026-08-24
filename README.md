# pi-goals

Plan mode for agreeing on goals in a one page markdown file. 

A goal is signed off only after a fresh read-only judge checks its evidence against the repo.

![the widget: live goals from the session's plan file, with the active goal's open subtasks](media/screenshot.png)

Like [pi-milestones](https://github.com/Neuron-Mr-White/UniPi/tree/main/packages/milestone) and
[burneikis/pi-plan](https://github.com/burneikis/pi-plan), it guides rather than guards. The
reminder cadence is copied from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) and the
resync-after-compaction from [tmonk/pi-goal-x](https://github.com/tmonk/pi-goal-x).

## Install

```bash
pi install npm:@wassname2/pi-goals
```

Or for development:

```bash
git clone https://github.com/wassname/pi-goals && cd pi-goals && npm install
pi -e ./src/index.ts
```

## Use

```
/goals CSV export for the report view
```

`/goals` enters plan mode and starts a conversation; the objective is an optional seed. From there:

1. Plan. The agent explores read-only
2. Review. The working set is printed in the transcript, then a menu asks Ready, Ready + compact,
   open in `$EDITOR`, or keep planning.
3. Work. The agent ticks subtasks, appends to `## Log` and `## Learnings`, fills `evidence:`, and
   calls `CompleteGoal` when a discriminator is satisfied. If it leaves the plan untouched for two
   turns, the working set is sent back with a short upkeep reminder.

Other commands: `/goals clear` deletes this session's plan file; `/goals judge <model-ref>` picks a
specific model for the sign-off judge (default: your current session model, else pi's default).

## The plan file format (a convention, not a schema)

```markdown
# ship the cache layer

Latency target came from the SLO review; keep the existing client API.

## User voice

- > "keep the client API, I don't want to touch every call site"

## Goals

1. [/] goal: Implement cache layer
  - subtle failure mode: cache silently bypassed, latency ok by luck
  - discriminator: hit-rate > 0.8 in load-test.log (a bypass reads ~0)
  - verify: pytest tests/cache -q && python bench/p95.py --max-ms 50
  - tasks:
    1. [x] wire cache client
    2. [/] eviction policy
  - evidence:
    - > load-test.log: p95=41ms, hit-rate 0.93 (not bypassed)

## Future work / out of scope

## Log
- 2026-06-15 14:02  cache client wired; eviction next

## Learnings
- the client retries on 503, so a cache miss storm looks like latency, not errors

## Appendix (context, not approved)
```


## Signing off a goal (`CompleteGoal`)

`CompleteGoal(goal)` is the one blessed tool. It spawns a strictly read-only `pi` subprocess (`-p
--no-session --no-extensions`, tools `read,grep,fin

## Prompts

All model-facing text lives in [`src/prompts.ts`](src/prompts.ts), in flow order.

## Develop

```bash
pi -e ./src/index.ts        # load locally
npm test                    # vitest: judge argv invariants, appendLog, decideSignOff fail-forward
npm run typecheck
npm run lint
```

## License

MIT
