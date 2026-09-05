# pi-goals

Make a short list of goals in one Markdown plan file. A persistent read-only subagent keeps the high-level context, reviews progress, and checks whether each goal is complete.

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
reminder cadence is copied from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) and the
resync-after-compaction from [tmonk/pi-goal-x](https://github.com/tmonk/pi-goal-x).

## Install

Requires `pi-subagents` 0.65.1 or newer.

```bash
pi install npm:pi-subagents
pi install npm:@wassname2/pi-goals
```

Or for development:

```bash
git clone https://github.com/wassname/pi-goals && cd pi-goals && npm install
pi -e npm:pi-subagents -e ./src/index.ts
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
3. Work. Ready is the only review action that starts work. It also starts the goal steward. The
   agent ticks subtasks, appends to `## Log` and `## Learnings`, fills `evidence:`, and calls
   `CompleteGoal` when a discriminator is satisfied. The goal steward rereads the full plan on each
   review. `CompleteGoal` resumes the same steward lineage instead of starting a fresh reviewer.
   Every human reply and Refine note in plan mode is saved verbatim under `## Interview`. After eight
   turns without a change above `## Log`, the worker gets a reminder and the steward gets a progress
   checkpoint.

Other commands: `/goals clear` disconnects this session from its active plan, preserving the
versioned file on disk; `/goals auto [minutes|off]` continues active goals after the agent settles
and then on that interval. It pauses after two automatic wakes with no working-plan change; `/goals
model <model-ref>` picks the steward model (default: the pi-subagents agent model). These are TUI
subcommands, not CLI flags.

## Prompts

Worker prompts live in [`src/prompts.ts`](src/prompts.ts). The read-only supervisor prompt and review requests live in [`src/steward.ts`](src/steward.ts).

## Develop

```bash
pi -e npm:pi-subagents -e ./src/index.ts  # load locally
npm test                    # all unit, flow, and Pi RPC tests
npm run test:rpc            # Pi RPC review flow with a local offline model
npm run typecheck
npm run lint
```

## License

MIT
