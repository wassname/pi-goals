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
pi -e .
```

## Use

```
/goals CSV export for the report view
```

`/goals` enters plan mode and starts a conversation; the objective is an optional seed. From there:

1. Align. The agent inspects technical facts read-only, then asks at least three task-specific
   questions in one chat round about the expected result, scope/constraints, and success/failure
   criteria. It waits for your answers before proposing the final plan. An explicit “no questions”
   or “skip questions” clause in the current objective waives this round for that plan only.
   “No q's” and “skip q's” are also supported. Negated instructions (“do not skip questions”) and
   quoted feature references (“add a 'skip questions' button”) do not waive alignment.
2. Review. When alignment is complete, the agent requests review and the full draft is printed.
   Check that User-visible result names the artifact or behavior you expect. The menu offers
   **Ready / Discuss / Edit / Cancel**. Discuss returns to normal chat and asks useful alignment
   questions, not a refinement-notes editor. Keep talking for as many turns as needed; the old draft
   alone cannot reopen the menu. When discussion is finished, the agent calls `RequestPlanReview`,
   even if the draft is unchanged. Discussion state survives reload. Edit opens the full plan directly.
   Escape also returns to chat and preserves the draft; explicit Cancel discards the current draft.
3. Work. Ready is the only review action that starts work. The agent ticks subtasks, appends to
   `## Log` and `## Learnings`, fills `evidence:`, and calls `CompleteGoal` when a discriminator is
   satisfied. Every human reply in plan mode is saved verbatim under `## Interview`.
   After eight turns without a change above `## Log`, the working set is sent back with a short upkeep
   reminder.

## Plan supervisor and auto-continue

Steward supervision and 60-minute auto-continue are enabled by default. A real supervisor starts at
Ready. Auto-continue is the fallback when stewardship is off; it does not run a competing timer while
supervision is enabled. Use `/goals steward off` or `/goals auto off` to opt out. Explicit preferences
survive clear and reload. Cleared legacy sessions adopt the new defaults on reload; active legacy
plans retain their settings so supervision is not attached midway through work.

Install/load **only pi-goals**. Its internal modules contain the supervisor; the package bundles
`pi-intercom` 0.10.0 and `@sting8k/pi-vcc` 0.5.0 as locked runtime dependencies. An already installed
Intercom is reused; otherwise pi-goals initializes its bundled copy after installed extensions load.
There is one Intercom registration per process, not an extra supervisor companion. VCC is used as
a compiler, not loaded as another extension. Pi core stays a peer dependency. **Herdr remains the
supported terminal host**. Both panes use the same Pi agent directory and configured package set;
explicit CLI resource choices are preserved without adding `-e` companions.

Ready is the human's plan approval. Pi-goals forks the planning session, initializes the supervisor
with the original plan and supervisor policy, and waits for acknowledged pairing before starting the
worker. The initial supervisor view can steer; it is not another mandatory plan-approval gate.
The supervisor fork is compacted unless its known context is already at most 20k tokens. If native Pi
reports that no older history is eligible for compaction, startup retains the fork unchanged and continues;
other compaction failures still block initialization. Pi-goals requests compaction only for the
supervisor. Later reviews compact above 100k **current-context** tokens (not cumulative
usage), or earlier for a smaller model context limit. Each model call explicitly supplies the
supervisor role and current canonical plan while retaining the compacted planning context and judgments.

The internal supervisor provides incremental VCC views and retains its decisions. While an assessment
is active, later routine updates coalesce into one pending marker instead of queuing model turns or
replacing the active view. Once settled, it requests one fresh VCC overview from the worker's latest
compaction summary and current branch. This is a bounded high-level summary, not a lossless transcript;
truncation is labeled and the overview names the read-only source session for omitted detail.
Each explicit goal checkpoint carries a fresh bounded worker snapshot, including the latest user direction;
it becomes visible only when that checkpoint is assessed. The canonical plan and checkpoint identity remain
separate from replaceable routine status.
The plan-aware policy checks every 50 model turns or 60 minutes, or when the worker settles with no tracked
background work. Absent optional trackers contribute zero tracked work. Installed process/subagent
providers that cannot answer remain unknown and do not prove the worker is finished. Unregistered
detached work is not tracked. The `SUPERVISOR.md` policy lookup is unchanged: project `.pi/SUPERVISOR.md`, then the Pi agent directory, then the built-in policy. Auto-continue is
suspended while the steward is enabled so there is only one continuation policy.

At each review the supervisor is prompted to visibly give a brief progress assessment and useful
advice, not just a delivery receipt. Its advice and no-intervention assessment are also displayed
as durable messages. Supervisor mode allows native read/grep/find/ls and the narrow supervisor
tools only. Writes, bash (including `!`), process/subagent/scheduler and unknown extension tools
are blocked at execution as well as hidden, including on reload and in a stopped plan fork.
This is a model-tool policy, not an OS sandbox for arbitrary trusted extension code.

All worker/supervisor traffic uses Intercom. Local lifecycle calls are ordinary pi-goals module
calls, with no plan-lifecycle RPC dispatcher or headless live Pi process. Disconnection invalidates
pending approval and is shown explicitly; a send does not prove receipt or execution.

One `CompleteGoal` call asks this supervisor about direction and scope, then runs the normal fresh
read-only evidence judge. A prematurely checked submitted goal is reopened before review; only accepted
sign-off checks it again. The judge's checks section accepts ordinary numbered and indented Markdown lists,
but an empty section cannot borrow a list from a later heading. Approving one goal does not finish supervision. Cancelled, stale or
mismatched replies do not sign off goals. Goal/revision identity is bound in code to the checkpoint
actually presented to the supervisor, not copied into a form by the model. Supervisor model checkpoints
have no arbitrary thinking deadline: slow healthy reviews may finish. Explicit cancellation, replaced
plans, disconnects and actual settled provider failures still fail safely; startup/attachment deadlines
are separate. A genuinely settled empty response returns an incomplete assessment, not an invented
human-input dependency. Later worker progress/cadence can resume supervision without a human poke,
and failure does not immediately retry the same view. A required completion checkpoint may wait, but routine supervision does not block worker
work. `/goals steward off` ends this plan's supervision and
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

For a local trial, start inside Herdr with just this checkout:

```bash
pi -e /path/to/pi-goals
```

Then draft a plan and select Ready; no enable command is needed. Initialization failure stays in
planning and names the unavailable component; resolve it in the supervisor pane, or turn the steward
off and retry Ready. Sessions saved with the older checkpoint-only steward need a new Ready handoff;
old pi-subagents reviewer runs are not reused as supervisor sessions.

### Migrating an already-running installation

After validating this package, remove any old standalone supervisor entry. A compatible standalone
Intercom may remain: pi-goals reuses it rather than registering a second copy. **Reload existing workers before selecting Ready again**:
an old worker still has old launch arguments in memory and can launch both old and internal copies.
Reload both sides of a retained pairing. Do not add extra `-e` supervisor/Intercom arguments.
Duplicate Intercom registries are diagnosed and plan bootstrap is refused; Pi also reports conflicting
tools from duplicate packages. Diagnose/remove the duplicate rather than starting more panes. No
settings or live panes are changed by this extension's migration.

### Remembered role models

Choose with `/model` or Pi's model-cycle shortcut in planning, the worker, or the supervisor. Each
pi-goals role remembers its own last explicit provider/model. On first use it inherits the current
model; no provider is hardcoded. Planning is restored on `/goals`, worker at Ready **after** the
planning fork is captured and before pairing activation/the work handoff, and supervisor before its initial compaction
or first turn. Reload/resume and later plans restore those choices. The supervisor does not inherit
the worker's goal tools or auto-continue policy.

Storage is under `getAgentDir()/pi-goals/` (normally `~/.pi/agent/pi-goals/`):
`planning-model.json`, `worker-model.json`, and `supervisor-model.json`. Each atomic file contains
only `{"provider":"…","id":"…"}`. Different role processes never rewrite each other's file; competing
explicit choices in the *same* role are last-write-wins. No credentials or thinking-level preferences
are stored. Automatic `setModel` and Pi's restore events do not replace role preferences.

If a remembered model is missing or unauthenticated, the role pauses with an error instead of
silently using a different provider. Configure the saved model and reload, or explicitly select a
different available model with `/model`. Pi does not emit a selection event when you choose the
already-current model; use **`/goals model current`** to explicitly save that current model for the
paused role instead. This command verifies authentication before replacing the saved choice.

A worker-model failure at Ready keeps the attached supervisor inactive and persists **worker** as
the recovery target across reload. Recovery updates the worker preference, not the planner's, and
reoffers the existing Ready menu; Ready retries the same fork without another approval stage.
There is no activation, supervisor review turn or work handoff before the worker model is usable.
`/goals clear` and `/goals steward off` still stop/cancel supervision while a model is unavailable;
old supervisor directives cannot restart the stopped work. A failed restore or recovery never
silently replaces a saved model choice.
`/goals judge <model-ref>` remains a separate override for the fresh evidence judge; it never changes
these role files.

## Prompts

Planning/judge text lives in [`src/prompts.ts`](src/prompts.ts); supervisor policy/text lives in [`src/internal/supervisor/prompts.ts`](src/internal/supervisor/prompts.ts).

## Develop

```bash
pi -e .                     # one package; reuses installed or bundled Intercom
npm test                    # unit/flow/RPC + inherited node:test supervisor regressions
npm run test:rpc             # real-Pi conversational review, local offline model
npm run test:supervisor      # inherited lifecycle/VCC/correlation/recovery regressions
npm run typecheck
npm run lint
npm run build
```

No supervisor checkout or opt-in environment variable is needed. `test/rpc-supervisor.test.ts`
performs `npm pack`, extracts the tarball outside the checkout, and runs real Pi sessions plus the
actual bundled Intercom broker and a fresh offline evidence judge. Only Herdr is mocked: the worker's
exec adapter imports the extracted goals entry, and the supervisor loads the untouched extracted
package manifest. The test checks bundled production resources and excludes bundled Pi core peers.
It requires Unix sockets on Linux and spends no API credits. The hook integration additionally
checks initial supervisor compaction/model order, native planning-fork capture, cancellation, two
goal reviews, and judge isolation without relying on a live terminal.

The moved VCC dependency is source-only and has upstream type incompatibilities with current Pi/Intl
unions. `tsconfig.build.json` maps just its four imported API surfaces to narrow local declarations;
the actual pinned VCC source still runs in tests and production. The Intercom extension factory
has the same narrow declaration boundary; no dependency code is rewritten. All pi-goals source is typechecked
and linted; the node:test suite is run separately, not silently collected/skipped by Vitest.

Baseline validation (2026-09-07, before the current supervision changes): **67 Vitest tests and 118 internal supervisor tests passed, with no skips**,
including the packed real-Pi/Intercom flow. Typecheck, lint, build and diff checks passed. Independent
review and targeted recheck are complete. See the [saved validation and review disposition](docs/reviews/2026-09-07_single-package-role-models.md).

The current isolated-worktree validation is recorded in [the approved supervision plan](docs/slop/plans/20260908_simple-visible-supervision.md). Packed registration/reload is also tested with Intercom loaded before or after pi-goals. The full Intercom peer flow and Herdr UAT need host Unix-socket/control access; do not treat registration alone as a successful supervision trial.

Neither automated test proves visual Herdr rendering/navigation or measured token savings. The
previous live trial contained a historical tool call without a saved result, which can still block
supervisor `done`. Use `/goals clear` to explicitly disconnect; genuine outstanding-work checks have
not been weakened. See [the prior validation record](docs/reviews/2026-09-07_supervisor-validation.md).

## License

MIT. See [third-party provenance and notices](THIRD_PARTY_NOTICES.md).
