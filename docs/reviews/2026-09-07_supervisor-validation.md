# Plan supervisor: implementation and trial status

2026-09-07. Feature-branch implementation, reviewed fixes and local trial. One live supervised goal completed successfully. Full navigation/reload UAT and token-saving measurements remain open. The user authorized registering the two companion packages in Pi settings and committing/pushing both feature branches. No npm release is part of this change.

## What changed

Pi-goals now forks a real supervisor session and starts it through native Herdr commands. The existing supervisor package supplies its policy, incremental VCC worker views and retained judgement. Ready waits for initialization and acknowledged pairing, then starts work; it is not a second plan-approval gate.

Routine checks use the 50-model-turn / 60-minute / settled-with-no-tracked-work policy. One CompleteGoal call requests a correlated supervisor decision before running the separate fresh evidence judge. Direct supervisor/worker focus and zoom commands replace Fleet navigation for this workflow. Small measured forks can skip compaction; larger/unknown forks use native compaction. Missing-pane recovery is deliberately manual.

## Parent-observed automated validation

[Saved default-on validation](evidence/2026-09-07_default-on-validation.log) records `Tests  48 passed (48)` across 11 files, plus typecheck, lint, build and diff checks. Both the actual-package hook test and real-Pi/Intercom test now initialize supervision without an explicit enable command. New regressions cover default-on migration, explicit-off persistence and preserving active legacy plans.

[Earlier full saved output](evidence/2026-09-07_supervisor-validation.log) covers all seven lifecycle review fixes, before the default-on change. Relevant excerpts:

```text
GOALS: enabled suite after R6/R7
 Test Files  11 passed (11)
      Tests  45 passed (45)
...
Checked 16 files in 56ms. No fixes applied.
...
ℹ tests 116
ℹ pass 116
ℹ fail 0
ℹ skipped 0
...
POST-R6-R7 PARENT VALIDATION PASSED
```

The goals suite ran with `PI_GOALS_SUPERVISOR_SOURCE` pointing to the matching supervisor branch. It included the actual two-Pi RPC / Intercom-broker / fresh-offline-judge test, with Herdr mocked. The hook integration additionally exercises two goals with actual package code and a persisted native fork, but mocks transport, Herdr and the judge. Neither is visual TUI proof. Typecheck, lint, build and both diff checks also passed. The supervisor suite ran through its literal `npm test`, not only the worker's alternate runner.

Reproduce from the goals worktree:

```bash
PI_GOALS_SUPERVISOR_SOURCE=/home/ubuntu/.pi/agent/worktrees/pi-intercom-supervisor-goals-integration/src/index.ts npm test
npm run typecheck && npm run lint && npm run build && git diff --check
cd /home/ubuntu/.pi/agent/worktrees/pi-intercom-supervisor-goals-integration
npm test && git diff --check
```

## Review disposition

All seven implementation findings were accepted and fixed:

- R1: preserve unknown context usage and remove the stale pre-compaction token floor.
- R2: cancel stale Ready handoffs after awaited activation and plan replacement.
- R3: invalidate suspended view/compaction continuations after stop or shutdown.
- R4: persist acknowledged initialization separately from provisional bootstrap state.
- R5: preserve explicit-stop state across cleanup and reload.
- R6: preserve and acknowledge worker activation during same-binding bootstrap replay.
- R7: keep the plan in starting until activation succeeds; steward-off returns it to planning.

The independent final review verified the original R1–R5 scenarios and found R6/R7. Its verdict was BLOCK for R6. The parent then authorized the two narrow fixes, inspected their source and regression tests, and ran the final suites above. No fourth independent review was launched: the three-round cap was reached. R6/R7 therefore have parent review and regression evidence, not a subsequent independent approval.

The orchestration script failed after the first fix worker because its progress object included an undefined optional output reference. Completed code/results were retained; only the unlaunched final reviewer was recovered. This did not constitute a code/test failure.

## Local trial

The user has registered all three local packages in Pi settings, so ordinary Pi startup now loads them. For a temporary trial elsewhere, start inside Herdr with the matching goals extension already loaded and pass the companions explicitly:

```bash
base="$HOME/.pi/agent/worktrees/pi-intercom-supervisor-goals-integration"
pi -e "$base/src/index.ts" -e "$base/node_modules/pi-intercom/index.ts"
```

Then use `/goals plan <objective>` and Ready. Steward and 60-minute fallback auto-continue now default to on; explicit off preferences persist. `/goals supervisor`, `/goals worker`, and `/goals zoom` operate on the recorded real panes. `/goals steward off` stops the relationship, not the terminal pane.

Observe both panes, switch and zoom, reload/compact the supervisor, then complete two goals. If a pane ID is lost, locate the existing supervisor before reopening its saved session; a missing pane ID is not evidence that its process exited. Unknown background providers are not evidence that all work finished. Automatic phase-model switching was not implemented.

## Live trial and remaining cleanup issue

The user completed one real Herdr-supervised file-table goal. The supervisor delivered a direction message, and CompleteGoal ultimately accepted the evidence after corrections to the saved command/transcript attribution. This establishes a live pairing, steering and goal-sign-off path; it does not establish two-goal persistence or focus/zoom/reload behavior.

After completion, the supervisor reported that its `done` call was blocked by `Cannot finish: the worker still has work running (write).` Its worker view still reported an unresolved write while the worker was settled and tracked processes/subagents were zero. The origin of this apparently stale tool state has not been diagnosed. Automatic whole-plan cleanup is therefore not verified. `/goals clear` explicitly disconnects the pairing and stops its watch timer while preserving the plan; the supervisor pane/session can remain as history. A new plan creates a new version and pairing.

The managed pi-goals checkout's pre-existing `package-lock.json` modification was left untouched. Development dependencies were installed only in the new supervisor feature checkout. The later user-approved settings change registers the existing local supervisor and Intercom copies; it does not upgrade or download packages.

<!-- Final implementation synthesis and observed validation by Pi. -->
