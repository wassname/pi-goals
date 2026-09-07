# Supervisor integration options

2026-09-07. Source-based recommendation, not implemented or tested as a live two-pane session. User intent: [Plan-aware persistent supervisor](../spec/2026-09-07_plan-supervisor.md).

## Recommendation

Compose `pi-goals` with `pi-intercom-supervisor` and its existing Intercom channel. Run the supervisor as a second real Pi session in a Herdr split. Use native Pi fork/resume and Herdr launch/focus facilities; keep a small adapter in pi-goals for the plan handoff and navigation.

This reuses the supervisor's policy, incremental views, decisions, and steering. It avoids both copying that runtime into pi-goals and placing a headless subagent behind a second UI. Both sessions remain ordinary Pi sessions that the human can inspect and address.

Herdr owns the terminals. Pi owns each session's history and compaction. The supervisor package owns the supervision relationship and observation cadence. Pi-goals owns the plan and individual goal-completion requests. Intercom transports messages. Pi-subagents can continue running the worker's delegated jobs without owning the supervisor.

## Existing examples and their fit

| Pattern | Fit for this task | Boundary |
|---|---|---|
| Intercom planner/worker + existing supervisor + native Herdr split | Recommended | New fork/bootstrap, plan-signoff, and cadence hooks still needed |
| Intercom `openProjectPaneIfMissing` | Useful launch/discovery example | Starts plain Pi; no explicit fork/session argument; cwd selection is insufficient to identify this supervisor |
| Pi-subagents `project.open` | Real visible Pi session | One binding per canonical cwd; options do not select a session file or supervisor role |
| Pi-subagents retained child + Fleet/Herdr inspector | Retains child context and managed lifecycle | Inspector reads artifacts and offers control; it is not the child's interactive Pi session |
| Messenger Crew/lobby + overlay | Useful for multi-worker task orchestration | Own task state and headless `--mode json --no-session -p` workers; overlay is chat/progress, not two real Pi terminals |

Intercom's README describes its planner/worker example as “one holds the big picture, the other does the hands-on work.” Its extension-channel example is the right transport pattern for non-conversational views and correlated goal requests: channel traffic alone starts no model turn. The supervisor already uses this channel and starts its own review when a view arrives.

The supervisor's `pi-supervise:pair:v1` event accepts an explicit worker Intercom identity and goal, and resolves on worker acknowledgement. It is emitted inside the supervisor process, not across the event bus from the worker. Its companion worker-state and paired events expose the identities needed by a launcher.

## Human interaction

Default to a named worker/supervisor split so both real sessions are visible. Focus either pane to type there; zoom temporarily when more width is needed. Offer direct pi-goals actions for opening/focusing the supervisor and returning to the worker. Exact slash spelling is still a proposal.

Installed help confirms this launch shape. These commands were NOT run:

```bash
herdr pane split --current --direction right --cwd "$PROJECT" --no-focus
# Take SUPERVISOR_PANE from the returned pane.pane_id.
herdr agent start goals-supervisor --kind pi --pane "$SUPERVISOR_PANE" -- --session "$FORK_SESSION_FILE"
herdr agent focus "$SUPERVISOR_PANE"
herdr agent focus "$WORKER_PANE"
herdr pane zoom --pane "$SUPERVISOR_PANE" --toggle
```

`--session` here opens an already-created distinct fork, never the worker's live file. Pi also supports `--fork <path|id>` to create the separate session at launch, so a native CLI fork followed by supervisor-side initialization may eliminate custom fork-file construction. Herdr `agent start` waits for the expected interactive agent to be detected and ready; its pane must initially be at a shell prompt. Use a unique name per pairing and retain the returned pane ID for control.

A separate Herdr tab is an alternative for switching; the split satisfies seeing both at once. Outside Herdr, an ordinary second terminal remains usable, but automatic terminal creation is a separate portability question. Do not build an additional fallback process manager before that need is established.

## Minimal integration work still required

1. **Bootstrap:** fork at the plan handoff, establish a supervisor-only role, compact the fork, provide the worker's explicit plan path and full plan, then pair. Do not restore the fork's inherited pi-goals activation as another worker, and do not truncate the plan into the routine 15 KB view. No supervisor judgement should run before initialization finishes.
2. **One review policy:** expose the proposed 50-model-turn / 60-minute / settled-and-no-background-work triggers in the supervisor package. Replace its stock 30-minute policy rather than running a second timer beside it. Count model turns, not transcript messages. Track the worker's registered processes/subagents and react when they finish; arbitrary unregistered detached work remains a visibility limitation.
3. **Per-goal request/reply:** add correlated goal-signoff and plan-update hooks. Stock `done` ends the entire pairing. A goal decision should return to pi-goals, which owns checkbox updates and the existing fresh evidence judge. A stale or duplicate reply must not approve another goal or plan version. The current two-call CompleteGoal protocol is not a user requirement.
4. **Recovery and navigation:** retain session/plan/pane identity; reconcile live Intercom identity and pairing on restart. Focus or resume the same supervisor instead of creating another. Do not open one session file in two live Pi processes. Preserve the original supervisor's decisions and reestablish policy/plan after compaction.

Keep VCC's incremental views and the supervisor's recent-view pruning initially. Use native compaction for the fork and later supervisor history. Measure token totals, cache reads, compaction cost, and whether useful interventions occur. The supervisor README's reported cost saving is not proof of an equivalent token reduction.

## Evidence and limits

Inspected Pi 0.84.4 and Herdr `0.8.2-preview.2026-09-06-9e9bc8a14466` CLI help. Herdr is installed, but this chat is not a Herdr-managed pane. No panes, agents, packages, or settings were started/changed for the research. Only documentation changed in this branch.

Source anchors:

- [Supervisor pairing and runtime](https://github.com/wassname/pi-intercom-supervisor/blob/409233cd4fb89e9b8c4a027affdedac5c9a8fddc/src/index.ts): pairing at 749–794; recent-view pruning at 535–556; settled reviews at 710–742. [Policy](https://github.com/wassname/pi-intercom-supervisor/blob/409233cd4fb89e9b8c4a027affdedac5c9a8fddc/src/prompts.ts) and [wire protocol](https://github.com/wassname/pi-intercom-supervisor/blob/409233cd4fb89e9b8c4a027affdedac5c9a8fddc/src/protocol.ts) show the reusable prompt and missing per-goal request.
- [Intercom 0.13.0 README](https://github.com/nicobailon/pi-intercom/blob/199279ae861bf53ce014809fb2a03337538ae13e/README.md): Planner-Worker Coordination, Extension channels. [Project launcher](https://github.com/nicobailon/pi-intercom/blob/199279ae861bf53ce014809fb2a03337538ae13e/project-agent.ts) accepts cwd/focus but not a selected session. Inspected the published npm tarball as well. The supervisor README's old `tintinweb/pi-intercom` link returned 404; current Intercom source is under `nicobailon`.
- [Pi-subagents current integration docs](https://github.com/nicobailon/pi-subagents/blob/54df154d1891db6b1a3e755539683335b9f9dbd3/docs/extension-api.md): Inspector panes, Project panes, Background-work provider API. Also inspected installed 0.60.0 source: `project-panes.ts:102–107,177–179,409–412,546–564` and `focus.ts:32–55`. Registry latest was 0.66.0; no upgrade was performed. Current source still distinguishes project sessions from headless-run inspectors.
- [Messenger 0.15.2 lobby launch](https://github.com/nicobailon/pi-messenger/blob/09937ed647a1b07a3b595bf75943feacb80ff123/crew/lobby.ts): `spawnLobbyWorker` uses print/JSON/no-session mode. [Overlay actions](https://github.com/nicobailon/pi-messenger/blob/09937ed647a1b07a3b595bf75943feacb80ff123/overlay-actions.ts) send messages and manipulate Crew tasks.
- Installed Pi SDK `docs/sdk.md`, `docs/session-format.md`, and `examples/sdk/11-sessions.ts`: session persistence, native branching, compaction, and CLI resume. Installed `herdr pane split --help`, `herdr agent start --help`, `herdr agent focus --help`, and `herdr pane zoom --help`: real interactive launch and navigation.

This is a fit comparison of the requested packages and their actual examples, not a package security audit or a measured reliability ranking. End-to-end fork/compact/pair, reload, background completion, sign-off, and visible switching remain to be tested.

<!-- Research and synthesis by Pi; recommendation pending user approval. -->
