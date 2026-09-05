# pi-goals

Make a short list of goals in one Markdown plan file. The main Pi agent supervises a cheaper retained worker through pi-subagents.

The plan file looks like this:

```md
## <short plan title>

<context: one short paragraph. What the human wants and why.>

### User-visible result

<one concrete sentence naming the final artifact or behavior the human will inspect>

### User voice

- │ "<the human's requirement, quoted in full word for word (with spelling fixes)>"

### Goals

1. [ ] goal: <one short judgeable imperative outcome>
- subtle failure mode: <a way this could look done but isn't>
- discriminator: <the concrete observation that tells real success from that failure>
- tasks:
    1. [ ] <subtask>
- evidence: (empty until sign-off)

### Future work / out of scope

### Log

### Interview

### Learnings

### Papercuts - problems, gotchas, suggestions
```

![the widget: live goals from the session's plan file, with the active goal's open subtasks](media/screenshot.png)

## Related work

Like [pi-milestones](https://github.com/Neuron-Mr-White/UniPi/tree/main/packages/milestone) and
[burneikis/pi-plan](https://github.com/burneikis/pi-plan), it guides rather than guards. The
plan resync after compaction follows [tmonk/pi-goal-x](https://github.com/tmonk/pi-goal-x).

## Install

Requires `pi-subagents` 0.65.1 or newer. Install `pi-processes` so the supervisor can check managed processes. Install `pi-vcc` as a Pi extension for main-session compaction; pi-goals also loads its package in the worker.

```bash
pi install npm:pi-subagents
pi install npm:@aliou/pi-processes
pi install npm:@sting8k/pi-vcc
pi install npm:@wassname2/pi-goals
```

Or for development:

```bash
git clone https://github.com/wassname/pi-goals && cd pi-goals && npm install
pi -e npm:pi-subagents -e npm:@sting8k/pi-vcc -e ./src/index.ts
```

## Use

```
/goals CSV export for the report view
```

`/goals` enters plan mode and starts a conversation; the objective is an optional seed. From there:

1. Plan. The agent explores read-only and drafts the plan.
2. Review. After Pi settles, the full plan is printed in the transcript. Check that User-visible
   result names the final artifact or behavior you expect. The menu offers Ready, Refine, Edit, or
   Cancel. Refine collects short notes. Edit opens the full plan in Pi's editor.
3. Work. Ready forks the approved-plan conversation into a cheaper `goal-worker`. pi-vcc compacts
   inherited context before the first worker turn when there is enough context to compact; a small
   exact fork is recorded as already below the compaction minimum. The main agent becomes the research
   supervisor. Worker completion wakes it through pi-subagents. It calls `CheckGoalWork` before deciding
   that all subagents and managed processes stopped, steers or resumes the retained worker with
   `GuideGoalWorker`, reads the evidence, and calls `CompleteGoal` to sign off. FleetView and
   `/subagents-fleet` show the worker. Every human reply and Refine note in plan mode is saved verbatim
   under `## Interview`.

Other commands: `/goals clear` disconnects this session from its active plan, preserving the
versioned file on disk. `/goals auto [minutes|off]` changes the supervisor check interval; Ready
enables a 60-minute interval. `/goals model <model-ref>` picks the cheaper worker model. Select the
stronger supervisor with Pi's normal `/model` command. Checks continue until all goals close, the
human uses `auto off`, or the plan is cleared.

## Prompts

Planning and sign-off prompts live in [`src/prompts.ts`](src/prompts.ts). Worker registration and pi-subagents RPC calls live in [`src/worker.ts`](src/worker.ts). [`src/worker-runtime.ts`](src/worker-runtime.ts) compacts the initial fork with pi-vcc.

## Develop

```bash
pi -e npm:pi-subagents -e npm:@sting8k/pi-vcc -e ./src/index.ts  # load locally
npm test                    # all unit, flow, and Pi RPC tests
npm run test:rpc            # Pi RPC review flow with a local offline model
npm run typecheck
npm run lint
```

## License

MIT
