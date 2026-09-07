# pi-goals

Make a short list of goals in one Markdown plan file. This is easy to review, and a subagent can check whether each goal is complete.

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
2. Review. After Pi settles, the full plan is printed in the transcript. Check that User-visible
   result names the final artifact or behavior you expect. The menu offers Ready, Refine, Edit, or
   Cancel. Refine collects short notes. Edit opens the full plan in Pi's editor.
3. Work. Ready is the only review action that starts work. The agent ticks subtasks, appends to
   `## Log` and `## Learnings`, fills `evidence:`, and calls `CompleteGoal` when a discriminator is
   satisfied. Every human reply and Refine note in plan mode is saved verbatim under `## Interview`.
   After eight turns without a change above `## Log`, the working set is sent back with a short upkeep
   reminder.

## Plan supervisor and auto-continue

Steward supervision and 60-minute auto-continue are enabled by default. A real supervisor starts at
Ready. Auto-continue is the fallback when stewardship is off; it does not run a competing timer while
supervision is enabled. Use `/goals steward off` or `/goals auto off` to opt out. Explicit preferences
survive clear and reload. Cleared legacy sessions adopt the new defaults on reload; active legacy
plans retain their settings so supervision is not attached midway through work.

This branch requires the matching
plan-aware `pi-intercom-supervisor` branch, `pi-intercom`, and Pi running inside Herdr. Both extensions
must be loaded in the worker; pi-goals passes their resolved paths to the supervisor.

Ready is the human's plan approval. Pi-goals forks the planning session, initializes the supervisor
with the original plan and supervisor policy, and waits for acknowledged pairing before starting the
worker. The initial supervisor view can steer; it is not another mandatory plan-approval gate.
The supervisor fork is compacted unless its known context is already at most 20k tokens. Only the
supervisor is compacted. Its normal context policy checks near 100k tokens, subject to its model limit.

The existing supervisor provides incremental VCC views and retains its decisions. The plan-aware
policy checks every 50 model turns or 60 minutes, or when the worker settles with no tracked
background work. Process/subagent providers that cannot answer are reported as unknown; they do not
prove the worker is finished. Standalone supervisor settings are unchanged. Auto-continue is
suspended while the steward is enabled so there is only one continuation policy.

One `CompleteGoal` call asks this supervisor about direction and scope, then runs the normal fresh
read-only evidence judge. Approving one goal does not finish supervision. Cancelled, stale or
mismatched replies do not sign off goals. `/goals steward off` ends this plan's supervision and
cancels pending goal requests; it does not close the human's terminal pane.

Navigation: `/goals supervisor` focuses the supervisor, `/goals worker` returns to the worker, and
`/goals zoom` toggles supervisor zoom. These use the real Pi panes, not a Fleet inspector. If the
recorded pane is unavailable, its location/liveness is unknown. Locate the existing session first;
only after confirming it is no longer running, reopen the saved `pi --session` path shown in the
error. Pi-goals never starts a duplicate merely because a pane ID is missing.

After completion, keep the plan as a record. Ordinary auto-continue stops when no open goals remain.
The supervisor's `done` ends the pairing and its watch timer; it leaves the terminal and saved session
available for inspection. `/goals clear` is the manual way to disconnect. A later `/goals plan …`
creates a new plan version and starts a new supervisor fork at Ready rather than reusing the completed
plan's pairing. You can close an old supervisor pane after supervision has ended.

Other commands: `/goals clear` disconnects this session, preserving its plan file;
`/goals auto [minutes|off]` controls ordinary auto-continue; `/goals judge <model-ref>` overrides the
fresh judge's model; `/goals steward status` reports supervision. Use `/goals plan <objective>` for
objectives beginning with reserved command words, such as `/goals plan judge the vendor options`.
The old `--clear`, `--auto`, and `--judge` forms remain compatibility aliases.

For a local trial, load the two feature checkouts explicitly in a Herdr-managed Pi session (replace
paths as needed; this does not change global package settings):

```bash
pi -e /path/to/pi-intercom-supervisor/src/index.ts \
   -e /path/to/pi-intercom-supervisor/node_modules/pi-intercom/index.ts \
   -e /path/to/pi-goals/src/index.ts
```

Then draft a plan and select Ready; no enable command is needed. Initialization failure stays in
planning and names the unavailable component; resolve it in the supervisor pane, or turn the steward
off and retry Ready. Sessions saved with the older checkpoint-only steward need a new Ready handoff;
old pi-subagents reviewer runs are not reused as supervisor sessions.

## Prompts

All model-facing text lives in [`src/prompts.ts`](src/prompts.ts), in flow order.

## Develop

```bash
pi -e ./src/index.ts        # load locally
npm test                    # all unit, flow, and Pi RPC tests
npm run test:rpc            # Pi RPC review flow with a local offline model
npm run typecheck
npm run lint
# Cross-package tests require the updated supervisor checkout:
PI_GOALS_SUPERVISOR_SOURCE=/path/to/pi-intercom-supervisor/src/index.ts npm test
```

The cross-package hook test uses actual extension code and a native persisted fork, with Herdr and
the evidence judge mocked. `test/rpc-supervisor.test.ts` starts two real Pi RPC sessions, the actual
Intercom broker and a fresh judge against a local offline model, with Herdr alone mocked. It requires
Unix sockets. Neither test proves visual pane navigation; live Herdr UAT is still required.

## License

MIT
