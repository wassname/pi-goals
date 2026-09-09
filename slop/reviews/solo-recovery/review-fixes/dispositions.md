# Independent review fixes: F1–F4

Base: `79ec5f3` (Continue approved goals with loud solo recovery on supervisor failure).

## Attribution and source confirmation

`../independent-review-79ec5f3.md` is a verbatim copy of the parent-supplied independent reviewer artifact, not this implementation worker's review. Source: `/home/code/.pi/agent/sessions/--home-code-.pi-agent-git-github.com-wassname-pi-goals--/subagent-artifacts/outputs/8ec5792f-53d8-4210-b79b-c027713186c8/solo-recovery-independent-review.md`.

Read the review, applicable AGENTS.md, README, prior implementation evidence and affected source/tests before changes. No panes, research sessions or journal contents were accessed. Unrelated dirty native logs were preserved byte-for-byte; see context.txt and preservation.txt.

## Dispositions

- **F1 confirmed and fixed.** Failed `stopSupervisor()` was classified as `SupervisorFailure`, authorizing solo for a healthy peer after a local Herdr close error. It now raises an ordinary error. A plain-error-only fix would have left worker readiness false after model restoration, so a previously connected pairing also restores its local readiness after the failed close. Plan, binding and tracked pane remain unchanged, no replacement starts, and the error remains visible. Regression verifies supervised status, allowed implementation and delivered steering afterward. Genuine launch/readiness failure still uses the approved loud fallback.
- **F2 partially confirmed; corrected diagnosis and fixed remaining gap.** Contrary to the review's code description, base `79ec5f3` already sent a not-ready hello **before** clearing the binding, and `connected` included both readiness flags. Thus delivery of that hello already disconnected the peer and blocked steering. The actual missing pieces were an explicit terminal detachment reason and distinguishing detached from starting/reconnecting in supervisor status. Solo now supplies that reason to `detach`, using the existing final hello, not a new protocol. The supervisor's readiness-status getter includes the peer-reported failure; rejected steering includes that reason. No received peer failure is copied into the local failure field or echoed back as one. Paired real GoalIntercom adapter tests cover explicit solo and terminal-supervisor-error fallback, a single solo announcement, rejected stale steering and a settled message count without reciprocal failure loops. The supervisor role test checks paused status and rejected steering/approval. Delivery of this final notice requires a reachable transport; no durable detachment-ack protocol or broader reconnect behavior was added.
- **F3 confirmed and fixed.** Solo manual completion claims now say `unreviewed (solo)`, retaining zero supervised sign-offs. Supervised claims retain `awaiting supervisor review`.
- **F4 confirmed and fixed.** The command cancellation token is now changed only after a command's no-op/rejection checks, in branches that intentionally change the plan/mode or initiate recovery. Six regression cases hold restart at its readiness wait, issue no-op supervise/noplan/model/busy-reconnect/already-solo/work-in-solo commands, then deliver peer readiness; recovery still completes. Existing clear-during-recovery cancellation tests remain passing. Valid plan-changing commands still supersede recovery; no new command or recovery framework was introduced.

## Observed validation

- New regressions against isolated **base source**: 11 failed, 53 skipped, expected exit 1. `baseline-regressions.txt` and the isolated-copy location in `context.txt` preserve the reproduction. This is intentional red-test evidence, not a final validation failure.
- Focused current-source run: 3 files / 71 tests passed (`focused.txt`).
- Full current-source `npm test`: 22 files / **149 tests passed** (`validation.txt`). This includes existing deterministic real Pi native/RPC lifecycle tests.
- `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`: passed.
- Tests unset inherited `PI_SUBAGENT_CHILD` and `PI_GOALS_ROLE` only for test processes and use the fresh explicit `review-fixes/native` evidence directory. Other commands retain their environment.
- The expected `fatal: not a git repository` stderr comes from the existing negative Ready preflight regression, which passes by rejecting unauthorized fallback.
- Fresh `native/` recordings establish the existing deterministic fork/resume path still runs, **not** real-model functional proof of the new review fixes.

## Remaining gaps / boundaries

The user reports reconnect often works only after reloading the worker and then reconnecting. **Unresolved, user-reported, not reproduced or fixed here**; broader reconnect investigation was explicitly deferred. Approved five-minute recovery and loud automatic solo fallback policy are unchanged.

Real-model Herdr rendered status/notice, useful autonomous continuation, both reload orders, restart-back-to-supervised and ApproveGoal → CompleteGoal acceptance remain outstanding. No real-session robustness success is claimed. Hung-but-ready peers, transient delay/credit policy, and message delivery guarantees are unchanged. The final detachment notice is best-effort on the current binding; offline peers cannot be notified by it.

Scoped fixes are committed locally for parent/reviewer follow-up; **not pushed**. Independent re-review of these fixes remains required before acceptance/push.
