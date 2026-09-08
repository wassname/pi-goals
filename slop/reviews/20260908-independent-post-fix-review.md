# Post-fix independent bug review — pi-goals supervision recovery

Scope: changes `2824396..1668c94` (fix commit `325b939` + evidence commit `1668c94`).
Inputs: AGENTS.md, `slop/reviews/20260908-review-fixes.md` (dispositions), `slop/reviews/20260908-independent-supervision-bug-review.md` (original F1–F9), full current sources of `src/{index,intercom,supervisor-session,approval,role-models,herdr}.ts`, changed tests, native evidence logs.
Read-only: no repo edits, no live panes, no messaging. Repro artifacts lived in /tmp only.

Labels: **[TESTED]** = executed/compiled and observed. **[CODE]** = unambiguous from source. **[INFERENCE]** = depends on runtime behavior I could not observe here. Test passage is treated as evidence of the asserted path only, not as design proof.

Baseline check: `env -u PI_SUBAGENT_CHILD -u PI_GOALS_ROLE npx vitest run` → 57/57 pass in 16 files, matching the worker's validation claim. **[TESTED]**

---

## Fix verification F1–F7

**F1 (unavailable remembered model aborts restore) — verified fixed. [CODE + repo tests]**
`session_start` now sets `modelError` first, configures the binding and timers independent of model selection, and only then attempts `restoreModel` in try/catch (`src/index.ts:557-580`). On failure: no `setModel`, no ready hello (`configure(..., false)` at :562, `markReady` gated on `!modelError` at :572-573), paused widget (`pauseReason`/`updateWidget` :149-153, 271-276), write/sign-off gating (:453-456, 592-597), human input and read-only diagnosis retained. `/model` saves over the failed role choice because `RoleModels.enter` sets `this.role` before throwing (`src/role-models.ts:29-30`), so `/goals reconnect` then picks up the user's replacement — a deliberate, workable recovery chain. No fallback model is substituted anywhere.

**F2 (resumed worker silently unsupervised) — verified fixed, with a residual in P3 below. [CODE + repo tests]**
`connected` now requires own-ready + binding + channel + peerReady (`src/intercom.ts:87`); `onConnectionChange` refreshes the widget immediately (:139, :145, :164); a resumed working worker hellos not-ready until its model restores, then `waitReady(5000)` and warns on failure (`src/index.ts:572-577`). Returning peers clear the pause automatically via the hello/`changed` path. Explicit `/goals restart` preserves plan/version and replaces only the tracked pane with a fresh approval binding (test asserts old checkpoint removed, plan unchanged, exactly one close).

**F3 (inactive-plan steer throws/replays) — lifecycle part fixed; delivery gap honestly open. [CODE + repo tests]**
`detach()` (`src/intercom.ts:72-81`) clears the binding on completion/clear/restart; late steers for a dead binding are dropped at the binding check (:151) without invoking `onSteer` or acking — covered by the new intercom tests. Ack ordering is still handoff-before-ack (:186-193), so a synchronous `sendUserMessage` throw leaves the steer unrecorded/unacked and it retries (test proves retry succeeds). The documented residual is real and correctly **not** claimed fixed: Pi 0.84.1's `sendUserMessage` is a void wrapper over an async enqueue, so an ack can precede an asynchronous enqueue failure, after which the instruction is gone from the supervisor's pending set and never reaches the model — silently. This is a genuine gap a future correlated-receipt protocol should close; the recorded UAT requirement (force an async enqueue rejection) is the right acceptance test. Acceptable as an explicitly-open item, not as a resolved one.

**F4 (stale pane → repeated 5-minute Ready waits) — verified fixed for the timeout itself. [CODE + repo tests]**
Existing-pane reconnect waits are 5s (`src/index.ts:186`, `:323`); first launch keeps the 300s compaction allowance (:213); failed `pane run` retains and reports the pane ID (:204-208); no automatic pane kill. **However, see P1: in one important sub-scenario the 5s retry fails deterministically even when the supervisor is healthy, so the fix's "retry" guidance does not actually recover there.**

**F5 (supervisor gets general `intercom` tool) — verified fixed. [CODE + native test]**
`intercom` is in `BLOCKED_TOOLS` (`src/supervisor-session.ts:13`), filtered from active tools at start and bootstrap (:108-110, :146), and blocked at tool-call time even if re-enabled (:170-173). The native pair test asserts the real supervisor model request's tool list excludes `intercom` and `bash`. Note the tool gate uses `terminate: true`, so a blocked call ends the whole supervisor turn — a deliberate-looking but behaviorally stronger choice than the planning gate's plain block.

**F6 (nested placeholder evidence) — verified fixed as far as claimed. [CODE + repo tests]**
Both the inline and child-bullet paths reject exactly `(empty until sign-off)` case-insensitively (`src/supervisor-session.ts:46,52`); the string matches the template in `src/prompts.ts:97`. Residual (documented as a presence floor): the child scan still accepts *any* deeper-indented nonblank bullet as evidence, and quoted variants like `"(empty until sign-off)"` pass. That is a semantic-judging limit, accurately disclaimed; supervisor judgment remains the real gate. Acceptable.

**F7 (last-goal hash includes Log/Interview) — verified fixed. [CODE + TESTED via unit tests]**
`goalBlock` now truncates the plan at `## Log` before scanning and ends the block at the next goal line or any `#`/`##` heading, with `trimEnd` (`src/approval.ts:43-58`). `approval.test.ts` covers duplicate goal text in the log, Interview section, next-goal boundary, and real block edits invalidating the hash; the flow test proves a manual log line between ApproveGoal and CompleteGoal no longer invalidates. Fail-closed on upgrade (old hashes need re-approval) is the right direction. One residual asymmetry (P4 below).

---

## New findings

### P1 — Reconnect/Ready-retry can wedge in a half-open state: peer hello is only re-sent on *perceived* state change (Medium) [TESTED]

`GoalIntercom.configure()` resets `peer`/`peerReady` (`src/intercom.ts:45-46`) and sends a hello, but the peer replies to a hello only when *its own* view changed (`src/intercom.ts:154-164`: `changed = !this.peer || this.peerReady !== message.ready; if (changed) this.hello()`). There is no periodic hello. If the peer's stored state already matches the incoming hello (same session id, same ready flag), it stays silent — so the side that reconfigured never learns the peer and `connected` stays false forever (until some unrelated broker `session_joined` at :148 happens to trigger a hello).

Reproduced in isolation (compiled real `src/intercom.ts` from HEAD, two links cross-wired as broker peers, script in /tmp, no repo changes):

```
after initial link:        worker.connected = true   supervisor.connected = true
after worker reconfigure:  worker.connected = false  supervisor.connected = true
waitReady REJECTED after 201 ms: Supervisor did not become ready through pi-intercom; inspect its pane.
supervisor steer() succeeded (reports sent)
worker delivered steer: null
```

Consequences, all reachable through new/changed code paths:

1. **`/goals reconnect` on a healthy link breaks it.** `src/index.ts:322-323` reconfigures the same binding; if nothing about readiness actually changed, every retry times out after 5s with "Goal recovery failed", and the only in-app escape is `/goals restart` — which closes the *healthy* pane and invalidates the approval binding (`beginReview` deletes checkpoints).
2. **The F1-on-Ready retry fails deterministically.** First Ready: `startSupervisor` completes the hello exchange (worker announced `ready=true` at `beginReview`/`configure`), then `restoreModel("worker")` throws → back to planning. After the user fixes the model, the next Ready takes the existing-pane path (`src/index.ts:184-186`): `configure` resets the worker's peer, hellos `ready=true`, the supervisor sees no change, stays silent, and `waitReady(5000)` times out — even though the supervisor is up and healthy. Every Ready/reconnect retry repeats this. This undercuts the F1/F4 recovery story on exactly the path those fixes target.
3. **Silent steer loss during the window.** While half-open, the supervisor's `connected` is true, so `SteerWorker` "succeeds", but the worker drops the message at `src/intercom.ts:166` (`event.fromSessionId !== this.peer`) with no notification; the steer sits in pending awaiting a changed hello that may never come. The SteerWorker result text ("Receipt and execution are not confirmed") softens but does not surface this.

Why the tests miss it: the fixture auto-replies to **every** hello with `ready: true` (`test/intercom-fixture.ts:21`), which is precisely the behavior the real peer logic does not have. The new peer-return and reconnect tests therefore cannot observe the change-gated reply.

Suggested direction (not implemented): reply to a hello whenever the sender may have lost state — e.g. have `configure` retain `peer`/`peerReady` when the binding is unchanged (re-handshake is only needed after a real transport/binding change), or include a monotonic hello generation and reply to any newer/unknown generation. An unconditional reply to every hello also works without ping-pong, because the *response* hello is still change-gated on the receiver's side.

### P2 — Failed Ready leaves the worker announcing `ready=true` while paused (Low) [CODE]

In the Ready flow, `beginReview` → `configure(approvalId, "worker", ctx)` defaults to `ready=true` (`src/intercom.ts:43`, `src/index.ts:171`). If `restoreModel("worker")` then throws (`src/index.ts:525` → catch at :537-544), the code rolls back `phase` to planning but never rolls back intercom readiness or detaches. The worker thereafter hellos `ready=true` on any broker event while `modelError` is set; the supervisor sees a ready, connected worker, `SteerWorker` sends successfully, and the worker's `onSteer` throws (`src/index.ts:113-116`) — unacked, error notification per replay. Self-consistent recovery exists (next Ready after `/model` works, modulo P1), so impact is confusing error noise and a misleading readiness signal, not loss. A `markNotReady`/detach in that catch would align the announced state with the pause.

### P3 — Worker pause message misattributes a *supervisor-side* pause (Low) [CODE]

`pauseReason()` (`src/index.ts:149-154`) collapses "peer absent" and "peer present but not ready" into one message: "Supervisor disconnected. Run /goals reconnect, or /goals restart…". When the supervisor pane is alive but paused on its own model restoration (`src/supervisor-session.ts:150-158` sets supervisor `modelError`, readiness stays false), the worker-side `/goals reconnect` will hello, get a `ready=false` reply, and time out after 5s — the advised action cannot work; the actual fix is `/model` + `/goals reconnect` in the supervisor pane. The supervisor pane does display its own error notification, and the design keeps both panes visible, so the user has the information — but the worker-side guidance points the wrong way. `peer` set + `peerReady` false is distinguishable from no peer; the message could be too.

### P4 — `goalBlock` and `tickGoal` now scan different regions (Low) [CODE]

Post-F7, `goalBlock` only sees the pre-`## Log` region (`src/approval.ts:44`), while `tickGoal` and `scanGoals` still scan the whole file (`src/index.ts:670-677`, :53-60). A goal-shaped line quoted inside the Log (e.g. a pasted checklist) yields: `goalBlock` finds a unique match → approval proceeds and hashes, but `CompleteGoal` → `tickGoal` finds two hits → returns null → sign-off blocked after a successful approval. Fail-closed, requires unusual plan content, and the same class of confusion pre-dates the fix (both sides failed before); noting it because the fix changed the boundary of only one of the two scanners.

### P5 — Ready catch can resurrect a cleared plan phase after a concurrent `/goals clear` (Low) [CODE/INFERENCE]

The Ready path awaits up to 300s inside `startSupervisor` (`src/index.ts:213`), and neither `detach()` nor `configure()` wakes `waitReady` waiters (only hellos/shutdown do; `detach`'s clearing of `binding` means its own not-ready hello is ignored by waiters, and the peer's reply is dropped by the now-empty binding check). If the user runs `/goals clear` during that wait, the plan state is cleared; when the wait later times out, the catch at `src/index.ts:537-544` unconditionally sets `phase: "planning"` and persists — yielding `phase: "planning"` with `planVersion: null`, a "drafting goals" widget over no plan, and "No active plan to disconnect" from `/goals clear`. Recoverable via a fresh `/goals <objective>`, and the interleaving requires issuing a command while the Ready select-loop is mid-wait, hence Low. I did not execute this interleaving; it follows from the unconditional catch and the waiter semantics. Guarding the catch on "state still belongs to this Ready attempt" (e.g. approvalId/planVersion unchanged) would close it.

---

## Assessment of documented residuals (not accepted on documentation alone)

- **F3 durable-delivery gap**: genuine and correctly scoped as open. Concretely, after an acked-but-async-failed enqueue, the supervisor waits indefinitely for a response to an instruction the worker model never saw, with no signal on either side; the recorded future UAT (inject an async enqueue rejection, assert no confirmed-delivery claim and recoverability) is the right bar. Fine to defer; not fine to call resolved — and it isn't.
- **F8 (unknown usage disables 100k compaction)**: the `?? 0` fallback (`src/supervisor-session.ts:187`) silently disables the custom compaction wherever `getContextUsage()` is unavailable, contradicting the AGENTS.md cost design with no user-visible signal. Mitigating factor I verified: the supervisor system prompt (with `planPath`) is re-appended every `before_agent_start` (:175), and approvals/checkpoints live on disk, so a fallback default-compaction does not lose the plan pointer or approval state — the consequence is cost/context-rot drift, not correctness. Still, a one-time "usage unknown; custom compaction inactive" notification would close the observability gap cheaply. Acceptable as a documented limitation; the silence is the weakest part.
- **F9 (planning/pause bash gate holes)**: accurately disclaimed as guardrail-not-sandbox. The paused-diagnostic gate (`src/index.ts:453-456`) intentionally inherits the same heuristic, including the `git diff --ext-diff` external-command hole that requires a pre-existing hostile `.git/config`. Given the threat model (trusted repo, trusted extensions), the README statement is sufficient; a hardened policy remains correctly out of scope.
- **Test-quality caveat**: beyond the fixture issue in P1, the native pair test drives only `SteerWorker`; the two-real-session `ApproveGoal → CompleteGoal` chain is still unexecuted end to end, so the F7 hash boundary and the view-freshness gate are verified only per-side (unit/flow tests) plus one real supervisor tool-list inspection. The disposition states this; I confirm it remains true at 1668c94.

## What is solid

- Shutdown/late-startup guards (`src/index.ts:180, 199-203, 210`) and the supervisor's `bootstrapping` `finally` fix are correct; the test proves no late persistence after shutdown.
- Queued pending steers when *own* readiness changes are handled correctly on both roles: republish is gated on `peerReady && this.ready` (`src/intercom.ts:158-162`), pause suppresses republication, and recovery replays exactly the unacked set from session entries. The only hole in this chain is P1's missing trigger.
- Approval binding safety (per-approvalId, head/tree/clean-worktree/goal-block-hash equality, restart invalidating old approvals) is preserved and extended by the restart flow.
- Human recovery availability while paused is real on both roles: input, read-only tools, `/model`, `/goals reconnect|restart|clear` all remain reachable; sign-off and writes fail closed.

## Summary

F1–F7 are fixed as claimed, with tests and native evidence matching the dispositions. The significant new finding is **P1**: the change-gated hello reply combined with `configure()`'s peer reset makes `/goals reconnect` and Ready-retry wedge half-open precisely when readiness did not change — including the F1-on-Ready retry scenario the fixes were built for — and steers are silently dropped in that window while `steer()` reports success. P2–P5 are low-severity consistency/guard gaps. Documented residuals F3/F8/F9 are honest; F3's delivery gap and F8's silent compaction-disable remain open items, not fixes.

Attribution: independent reviewer, run bdb93a2e-52f4-4a6d-bac2-7c9eb48118b5; preserved verbatim by Pi/OpenAI implementation worker.
