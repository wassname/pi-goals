# pi-goals

Make a short list of goals in one Markdown plan file. This is easy to review, and a subagent can check whether each goal is complete.

The plan file looks like this:

```md
## <short plan title>

<context: one short paragraph. What the human wants and why.>

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

1. Plan. The agent explores read-only and drafts the plan.
2. Review. After Pi settles, the full plan is printed in the transcript. The menu offers Ready,
   Refine, Edit, or Cancel. Refine collects short notes. Edit opens the full plan in Pi's editor.
3. Work. Ready is the only review action that starts work. The agent ticks subtasks, appends to
   `## Log` and `## Learnings`, fills `evidence:`, and calls `CompleteGoal` when a discriminator is
   satisfied. Every human reply and Refine note in plan mode is saved verbatim under `## Interview`.
   If it leaves the plan untouched for two turns, the working set is sent back with a short upkeep
   reminder.

Other commands: `/goals --clear` deletes this session's active plan file; `/goals --judge <model-ref>`
picks a sign-off judge model (default: your current session model, else pi's default). The `--` prefix
keeps ordinary objectives such as `judge model quality` from being parsed as commands.

## Prompts

All model-facing text lives in [`src/prompts.ts`](src/prompts.ts), in flow order.

## Develop

```bash
pi -e ./src/index.ts        # load locally
npm test                    # vitest: unit checks plus Pi RPC review flow with a local offline model
npm run typecheck
npm run lint
```

## License

MIT
