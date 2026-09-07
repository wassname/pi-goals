# Plan-aware supervisor integration

Approved direction: compose the existing supervisor with native Pi/Herdr sessions. See [intent](../../spec/2026-09-07_plan-supervisor.md) and [final validation](../../reviews/2026-09-07_supervisor-validation.md).

- [ ] goal: Ready creates a real, plan-aware supervisor that the user can open beside the worker
  - [x] Replace the checkpoint reviewer with native fork/bootstrap, acknowledged pairing and a Herdr launch/focus adapter.
  - [x] Compact only the supervisor; supply the explicit worker plan and isolate the supervisor role.
  - [x] Observe live supervisor steering and accepted sign-off for one goal.
  - [ ] Verify navigation, reload, two-goal persistence and automatic whole-plan cleanup in Herdr.
  - failure modes: dashboard mistaken for a session; inherited worker automation; duplicate startup.
  - deliverable: branch implementation and trial route; live visual acceptance remains open.
  - evidence: [final log](../../reviews/evidence/2026-09-07_supervisor-validation.log) shows 45 enabled goals tests passing, including two real Pi processes and actual Intercom; Herdr is mocked.
- [x] goal: One supervisor checks progress at the agreed cadence without following every worker turn
  - [x] Use one 50-model-turn / 60-minute / settled-and-no-tracked-work policy, VCC views, retained verdicts and supervisor-only compaction.
  - failure modes: duplicate timers; message count substituted for model turns; unknown work treated as finished.
  - deliverable: supervisor branch with deterministic cadence, background-state and compaction coverage.
  - evidence: [final log](../../reviews/evidence/2026-09-07_supervisor-validation.log) includes passing 50-turn, hour/turn coincidence, unknown-provider, background-completion and nullable-compaction regressions. Token savings are not yet measured.
- [x] goal: Goal sign-off asks that supervisor and still checks evidence independently
  - [x] Correlate goal requests and replies; preserve pairing between goals; keep the worker and fresh judge as the completion path.
  - [x] Cover stale replies, cancellation, interrupted bootstrap, lost acknowledgement and explicit stop/reload.
  - failure modes: one goal ends all supervision; an old response approves another goal; disabled-only tests.
  - deliverable: single-call sign-off with actual-package and real-Pi integration tests.
  - evidence: [final log](../../reviews/evidence/2026-09-07_supervisor-validation.log) records 45 goals and 116 supervisor tests passing without skips; [report](../../reviews/2026-09-07_supervisor-validation.md) distinguishes the real and mocked boundaries.
- [x] goal: The two branches are reviewable and ready for a user trial
  - [x] Complete the single-writer implementation, independent review, accepted R1–R7 fixes and final parent diff/test checks.
  - failure modes: mocks hide the package boundary; undisclosed updates; unrelated settings/lockfiles change.
  - deliverable: [review disposition, saved validation and trial commands](../../reviews/2026-09-07_supervisor-validation.md).
  - evidence: final log ends `POST-R6-R7 PARENT VALIDATION PASSED`; typecheck/lint/build and both diff checks passed. R6/R7 were parent-reviewed after the independent three-round cap, not independently re-reviewed.

## UAT / Verification

- Success: Ready initializes and pairs; goal review reaches the correct supervisor and fresh judge. Automated enabled-path evidence is saved above.
- Likely failure: unavailable Intercom/Herdr/API produces an actionable error, with no false approval; covered in tests.
- Sneaky failure: pending work, stale replies or restarted identities cause a false finish; targeted lifecycle regressions pass.
- Still required: see/focus/zoom both real Herdr sessions, reload/compact the supervisor and finish two goals. Measure supervisor token use and usefulness on real work.

## Constraints and state

- Goals: `/home/ubuntu/.pi/agent/worktrees/pi-goals-persistent-steward`, branch `feature/persistent-steward`.
- Supervisor: `/home/ubuntu/.pi/agent/worktrees/pi-intercom-supervisor-goals-integration`, branch `feature/pi-goals-integration`.
- State: automated default-on validation passes 48 goals tests; one live supervised goal accepted. Full Herdr UAT remains open, including an apparently stale unresolved-write cleanup blocker. User authorized companion-package settings and feature-branch commit/push; no npm release.
- Manual lost-pane recovery remains explicit. The managed pi-goals lockfile, APC files and personal journals were not edited. No council or automatic phase-model switching.

<!-- Plan and final evidence read by Pi. -->
