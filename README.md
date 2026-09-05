# pi-goals

Make a short list of goals in one Markdown plan file. The main Pi agent is a thin coordinator for a retained supervisor, which controls a nested retained implementation worker through pi-subagents.

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

Requires `pi-subagents` 0.65.1 or newer. Install `pi-processes` so the supervisor can check managed processes.

```bash
pi install npm:pi-subagents
pi install npm:@aliou/pi-processes
pi install npm:@wassname2/pi-goals
```

Or for development:

```bash
git clone https://github.com/wassname/pi-goals && cd pi-goals && npm install
pi -e npm:pi-subagents -e .
```

## Use

```
/goals CSV export for the report view
```

`/goals` enters plan mode and starts a conversation; the objective is an optional seed. From there:

1. Plan. The agent explores read-only and drafts the plan.
2. Review. After Pi settles, the full plan is printed in the transcript. Check that User-visible
   result names the final artifact or behavior you expect. Ready starts the retained supervisor with
   a small fresh context and preserves the main context. Ready (compact) starts that supervisor first,
   then requests Pi's normal compaction of the main session only. It never compacts the retained
   supervisor or worker. Refine collects short notes. Edit opens the full plan in Pi's editor.
3. Work. The topology is:

   ```text
   main coordinator
   └── retained supervisor
       └── retained implementation worker
   ```

   The retained `goal-supervisor` rereads the full current plan on each direction or review, controls
   the nested `goal-worker`, inspects the actual repository and saved evidence, then writes a private approval checkpoint in
   `.pi/pi-goals/approvals/`. The worker is the implementation writer. Main and supervisor block direct
   `edit`, `write`, and write-like shell commands, but can inspect and run standard verification
   commands. This is not a filesystem sandbox: allowed scripts and custom tools can still mutate.
   `CompleteGoal` is mechanical. It checks that worker/supervisor/process work is idle and that the
   latest review ID, goal block, clean worktree, and committed HEAD/tree still match. The review ID
   prevents stale approval; it is not a security boundary against a worker that deliberately writes Pi state.
   `CheckGoalWork`, FleetView, and `/subagents-fleet` inspect the retained tree and transcripts. Every
   human reply and Refine note in plan mode is saved verbatim under `## Interview`. Pi and pi-subagents
   own normal compaction and retained-run recovery.

Other commands: `/goals clear` stops the retained tree and disconnects the active plan, preserving
its file. `/goals auto [minutes|off]` changes the check interval; Ready enables 60 minutes.
`/goals model <model-ref>` sets the supervisor model; `/goals worker-model <model-ref>` separately
sets the implementation-worker model. Checks continue until all goals close, `auto off`, or clear.

## Prompts

Planning and coordinator sign-off prompts live in [`src/prompts.ts`](src/prompts.ts). Supervisor registration and RPC calls live in [`src/worker.ts`](src/worker.ts). The packaged worker definition lives in [`agents/goal-worker.md`](agents/goal-worker.md), and the supervisor-only approval tool lives in [`src/supervisor-runtime.ts`](src/supervisor-runtime.ts).

## Manual check

1. Reload pi-goals with pi-subagents, create a small plan, and choose **Ready**. Open FleetView or run
   `subagent({ action: "status", view: "fleet" })`. It should show `goal-supervisor` and its nested
   `goal-worker`, not sibling runs from the main session.
2. Ask the main session to edit a project file. Its direct `edit`, `write`, or shell redirection call
   should be blocked. Call `CompleteGoal` before a supervisor review. It should fail because no matching
   private approval exists.
3. Let the worker implement, commit, and save verify output. Ask the supervisor to inspect the plan,
   repository, evidence, and output. Its nested worker instruction should appear in the nested
   transcript. After it calls `ApproveGoal`, inspect the JSON under `.pi/pi-goals/approvals/`.
4. Call `CompleteGoal` with the exact goal text. It should tick only while the checkpoint's goal-block
   hash and committed clean repository still match. Change the plan block or worktree and retry; it
   should fail closed until a new supervisor review.

## Develop

```bash
pi -e npm:pi-subagents -e .  # load the extension and packaged worker locally
npm test                    # all unit, flow, and Pi RPC tests
npm run test:rpc            # Pi RPC review flow with a local offline model
npm run typecheck
npm run lint
```

## License

MIT
