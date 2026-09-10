# pi-goals

Make a short list of goals in one Markdown plan file. The main chat keeps the high-level context, supervises a worker in a visible Herdr pane, and checks whether each goal is complete.

<img width="2513" height="1259" alt="2026-09-10_15-30-pi-goals" src="https://github.com/user-attachments/assets/35feaa15-f022-4491-bcc2-fc31cb878a9f" />

Abridged text from the isolated test, with approval and completion shown together. Paths are shortened; bracketed labels are annotations. Model names and token counts below illustrate the intended supervisor/worker split, not measurements from this capture.

```text
+-----------------------------------------------------------+-----------------------------------------------------------+
| SUPERVISOR                                                | WORKER                                                    |
|                                                           |                                                           |
| Review .pi/plan/...-main.md                               | Task 2 — verify command run, real output saved:           |
| > Ready    Discuss    Edit    Cancel                      | - Exit code 0 (pass only)                                 |
|                                                           | - evidence/verified.log (112 bytes)                       |
| [scheduled prompt: hourly check-in]                       |   PASS: 9 bytes: verified + LF                            |
|                                                           |                                                           |
| The supervisor independently inspected both artifacts     | Task 3 — plan evidence filled                             |
| before sign-off.                                          |                                                           |
|                                                           | Completion report sent via Intercom to supervisor         |
| Schedule: job wS79fJFPbB removed;                         | 01a089c9. My pane remains open for the supervisor’s       |
| .pi/schedule-prompts.json shows 0 jobs.                   | independent inspection before sign-off.                   |
|                                                           |                                                           |
| ✓ verified.txt holds exactly the 9 bytes                  | ○ verified.txt holds exactly the 9 bytes                  |
|   verified + LF                                           |   verified + LF                                           |
|   evidence/verified.log records a real byte check         |   evidence/verified.log records a real byte check         |
|                                                           |                                                           |
| Agents · 1 running                                        | [idle widget still shows its earlier snapshot]            |
|   verified-bytes-worker [goals-worker]                    |                                                           |
|                                                           |                                                           |
| >                                                         | >                                                         |
| astra · 50k tokens                                        | terra · 200k tokens                                       |
+-----------------------------------------------------------+-----------------------------------------------------------+
```

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

## Related work

Like [pi-milestones](https://github.com/Neuron-Mr-White/UniPi/tree/main/packages/milestone) and
[burneikis/pi-plan](https://github.com/burneikis/pi-plan), it guides rather than guards. The
reminder cadence is copied from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) and the
resync-after-compaction from [tmonk/pi-goal-x](https://github.com/tmonk/pi-goal-x).

## Install

Requires Herdr, [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents), pi-intercom and pi-schedule-prompt. Remove the unrelated `npm:pi-subagents` package if installed.

```bash
pi install git:github.com/edxeth/pi-subagents@v2.9.0
pi install npm:pi-intercom
pi install npm:pi-schedule-prompt
pi install git:github.com/wassname/pi-goals@experiment/main-supervisor-edxeth
```

Copy [`prototype/agents/goals-worker.md`](prototype/agents/goals-worker.md) into `~/.pi/agent/agents/`, then start a fresh Pi session.

Or for development:

```bash
git clone -b experiment/main-supervisor-edxeth https://github.com/wassname/pi-goals
cd pi-goals && npm install
pi -e ./src/prototype.ts
```

## Use

```
/goals new CSV export for the report view
```

`/goals` opens the action menu. New plan enters plan mode and starts a conversation; the objective is an optional seed. From there:

1. Plan. The agent explores read-only and drafts the plan.
2. Review. After Pi settles, the full plan is printed in the transcript. Check that User-visible
   result names the final artifact or behavior you expect. The menu offers Ready, Discuss, Edit, or
   Cancel. Discuss continues the conversation. Edit opens the full plan in Pi's editor.
3. Work. Ready is the only review action that starts work. It opens the worker in a Herdr pane. The
   worker ticks subtasks, appends to `## Log` and `## Learnings`, and fills `evidence:`. The supervisor
   inspects the actual results and calls `CompleteGoal` when a discriminator is satisfied. They
   communicate through pi-intercom. After eight turns without a change above `## Log`, the agent gets
   an upkeep reminder. The supervisor also sets an hourly check-in through pi-schedule-prompt.

Other commands: `/goals stop` pauses work; `/goals resume` continues it; `/goals exit` leaves goal
mode, preserving the plan. `/goals attach <path>` reconnects an existing plan. `/goals solo` lets the
main chat do the work after confirming other workers stopped; completion is then self-verification.
`/goals model <model-ref>` picks the worker model. `/schedule-prompt` manages check-ins.

Stop workers before reloading the supervisor: the subagent package can otherwise crash it when a
worker later exits. The scheduler deletes disabled jobs on reload. [Test results and recovery](slop/reviews/20260910_package-supervision-herdr.md).

## Prompts

You can read all the prompts in conversation order in [`src/prompts.ts`](src/prompts.ts).

## Develop

```bash
pi -e ./src/prototype.ts     # load locally; do not also load the installed copy
npm test                    # all unit, flow, and Pi RPC tests
npm run test:rpc            # Pi RPC review flow with a local offline model
npm run typecheck
npm run lint
```

## License

MIT

Branch-specific edits: Pi/OpenAI.
