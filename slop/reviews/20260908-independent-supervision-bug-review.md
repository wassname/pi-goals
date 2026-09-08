# pi-goals supervision bug review — HEAD 2824396

> Attribution: independent delegated reviewer, run `5c8c2017-a92f-4a5f-baf6-f441f9b50495`, artifact `supervision-bug-review.md`. Findings below are preserved from that reviewer, not authored by the implementation worker. Implementation dispositions are in `20260908-review-fixes.md`.

Scope: AGENTS.md, src/{index,intercom,supervisor-session,background,role-models,approval,worker-view,herdr,prompts}.ts and tests.
Priorities: lifecycle/reload, delivery/reconnect, approval safety, autonomy failures.
Method: static review plus targeted checks against the installed `@earendil-works/pi-coding-agent` 0.84.1 and `pi-intercom` 0.13.0 sources, and one live reproduction (F1). Nothing in the repo was modified; repro scripts lived in /tmp.

Labels: **[TESTED]** = demonstrated by execution or verified against dependency source. **[CODE]** = read directly from pi-goals source; control flow unambiguous. **[INFERENCE]** = depends on behavior I could not observe.

---

## F1 — Working-phase session restore aborts halfway when the remembered role model is unavailable (Medium) [TESTED]

`src/index.ts:486-495` (`session_start`):

```ts
if (state.phase) await models.enter(...);          // line 488 — can throw
planningContextPending = state.phase === "planning";
resyncReason = state.phase === "working" ? "New session." : null;
if (state.phase === "working") {
    intercom.configure(state.approvalId!, "worker", ctx);   // line 492 — skipped on throw
    startWorkerTimers(ctx);                                 // line 493 — skipped
}
updateWidget(ctx);                                          // line 495 — skipped
```

`RoleModels.enter` (`src/role-models.ts:30-40`) throws `worker model is unavailable...` when the saved `.pi/pi-goals/models/worker.json` names a model that `ctx.modelRegistry.find` can no longer resolve (provider removed, auth expired). That is a realistic state: the feature exists precisely to remember models across sessions, and model availability changes over time.

Reproduction (executed): mock Pi host, persisted state `{phase: "working", approvalId: "appr-1", planVersion: 1}`, saved worker model `gone/expired`, `modelRegistry.find → undefined`. Result:

```
session_start handler threw: worker model is unavailable. Select an available model with /model, then retry. Saved choice was not replaced.
intercom.configure called during working-phase restore: false
```

Consequences after the throw:
- Intercom binding is never restored: no hello, `peerReady` stays false, every subsequent `publishWorkerView` silently records views with an empty binding and never publishes them.
- The hourly view timer never starts.
- Widget is not updated.
- On a planning-phase resume, `planningContextPending` is never set, so the planning snapshot is never re-injected.
- Pi catches per-handler errors (`ExtensionRunner.emit`, runner.js:587-601) and routes them to `emitError`, so the user sees at most an extension-error diagnostic. The error text says "then retry", but no code path retries the restore — `session_start` does not re-run when the user picks a new model.

This overlaps F2: the session resumes looking normal while supervision is dead.

## F2 — No supervisor liveness check on worker resume; dead supervisor pane is invisible (Medium) [CODE]

`src/index.ts:486-495`: on resume with `phase === "working"`, the worker calls `intercom.configure` (which sends one hello) and starts timers. There is no `waitReady`, no Herdr pane probe, and no timeout. If the supervisor pane died while the worker session was closed:

- `GoalIntercom.view()` (`src/intercom.ts:82-88`) records the view and skips publishing because `connected` is false — silently. No notify anywhere on this path.
- `updateWidget` still renders "· supervised" (`src/index.ts:249`).
- The worker system prompt tells the model to "Stop when a goal appears complete so the supervisor can inspect a settled worker view" — it will stop and wait for an approval that can never arrive. `CompleteGoal` then fails with "no matching supervisor approval checkpoint" with no hint that the supervisor is gone.
- The only reconnect wait (`waitReady`) lives in `startSupervisor`, which is unreachable from the working phase: the Ready menu only renders when `state.phase === "planning"` (`src/index.ts:417`). The only recovery is `/goals clear` (drops plan linkage) or `/goals <new objective>` (new plan version, old plan orphaned). There is no "restart supervisor" path that preserves the current plan.

[INFERENCE] Whether the broker notices the dead pane while the worker is offline is irrelevant here — the worker has no handler for "peer never came back after resume" in either case.

## F3 — `onSteer` rejection throws before ack: unacked steer replays forever, error notification each reconnect (Medium-low) [CODE]

`src/index.ts:113-116`:

```ts
intercom.onSteer = (instruction) => {
    if (state.phase !== "working") throw new Error("Worker plan is not active; instruction rejected.");
    pi.sendUserMessage(`[supervisor] ${instruction}`, { deliverAs: "steer" });
};
```

`src/intercom.ts:167-174` (worker steer branch):

```ts
this.onSteer(message.text!);          // throws → everything below skipped
this.received.add(message.id);
this.record("in", message);
this.publish({ ... kind: "received" ... });
```

Because `onSteer` runs before dedupe/record/ack, a steer that arrives when the plan is not active (plan just completed — `publishWorkerView` sets `phase: null` at index.ts:213; or `/goals clear`; or a supervisor that ignores "stop issuing instructions") is:
1. never acked — the supervisor keeps it in `pending` and republishes it on every `changed` hello (`src/intercom.ts:143-149`), so each supervisor reconnect re-fires the throw;
2. never recorded — so the dedupe set can't suppress it;
3. surfaced only as `Goal Intercom error: ... instruction rejected.` notifications in the worker pane; the supervisor's `SteerWorker` result says only "Receipt and execution are not confirmed", so the supervisor model cannot distinguish "rejected" from "lost" and may re-send, producing one error notification per attempt.

Related at-least-once window: a crash between `pi.sendUserMessage` (persisted) and `record("in", ...)` causes the same `[supervisor] ...` instruction to be delivered twice after resume. Narrow, but the fix is the same: record/ack before invoking `onSteer`, and add a rejection result back to the supervisor instead of throwing.

## F4 — Stale `supervisorPaneId` makes every Ready retry block for 5 minutes (Medium-low) [CODE]

`src/index.ts:163-166`:

```ts
if (state.supervisorPaneId && state.approvalId) {
    intercom.configure(state.approvalId, "worker", ctx);
    await intercom.waitReady();        // default 300_000 ms, intercom.ts:73
    return;
}
```

This reconnect path is taken after a partial `startSupervisor` failure — e.g. `herdr pane split` succeeded (pane id persisted via the `onOpened` callback at index.ts:174-176) but `herdr pane run` failed (`src/herdr.ts:76-84`), or `models.enter("worker")` threw after the supervisor started. The pane is dead or the supervisor process exited, but the retry never asks Herdr whether the pane exists; it blocks the `agent_settled` handler (and therefore the planning menu) until the 5-minute `waitReady` timeout. Every subsequent Ready repeats the 5-minute hang. `/goals clear` recovers (`closeSupervisorPane` tolerates `NOT_FOUND`/`PANE_GONE`, herdr.ts:60-66), but the timeout error message ("inspect its pane") does not say so.

Also note the same 5-minute blocking wait applies to the supervisor's first-time initial compaction (`supervisor-session.ts:133-160`); a slow compaction of a large fork produces the same opaque worker-side failure, though that path self-heals on retry.

## F5 — The "read-only" supervisor gets pi-intercom's full `intercom` tool (Low-medium, approval/authority surface) [TESTED against pi-intercom source]

The supervisor runs with `--no-extensions -e src/index.ts` (`src/herdr.ts:48-58`), so pi-intercom is never an installed extension in the supervisor session, so `GoalIntercom.loadIntercom` (`src/intercom.ts:189-200`) always dynamically imports it. `intercom(api)` executes pi-intercom's full default export, which registers:

- the `intercom` tool: "Send a message to another pi session running on this machine" (pi-intercom/index.ts:2088),
- `/intercom`, `/intercom-id`, `/alias` commands (pi-intercom/index.ts:2802-2812).

The supervisor's read-only enforcement filters only `WRITER_TOOLS` (`src/supervisor-session.ts:13`, applied at session_start line ~124 and in bootstrap), so `intercom` remains an active tool for the supervisor model. Effect: the supervisor — prompted as read-only with `SteerWorker`/`ApproveGoal` as its only actuators — can message arbitrary Pi sessions on the machine, including the user's other sessions, outside the auditable SteerWorker channel whose renders the tests assert are visible. Severity depends on how much you trust the supervisor model; the capability contradicts the stated design ("all supervisor thinking and messages should be visible", AGENTS.md).

Mitigation would be filtering `intercom` (and any other messaging tools) out of the supervisor's active set, or passing a `registerTool` denylist through the `loadIntercom` proxy (it currently only wraps `on`).

## F6 — `hasEvidenceEntry` accepts placeholder or unrelated nested bullets as evidence (Low) [CODE]

`src/supervisor-session.ts:41-60`. The inline placeholder `(empty until sign-off)` is rejected, but when the inline value is empty the child scan returns true for *any* deeper-indented bullet with nonblank text — including `- (empty until sign-off)` written as a child bullet, or any stray nested line. So this block passes the gate:

```
1. [ ] goal: x
  - evidence:
    - (empty until sign-off)
```

The supervisor model is instructed to actually read the evidence, so this is a heuristic floor rather than the real defense; still, the placeholder check should apply to child bullets too.

## F7 — Approval goal block for the last goal runs to EOF; tail edits spuriously invalidate approvals (Low) [CODE]

`goalBlock` (`src/approval.ts:36-53`) slices from the goal line to the next goal line *or EOF*. For the last goal, the block includes `## Log`, `## Interview`, and the Appendix. `hashGoalBlock` therefore changes if the worker appends a manual `## Log` line (which the prompts encourage — `stamp()` exists for that) between `ApproveGoal` and `CompleteGoal`, producing "no matching supervisor approval checkpoint" and forcing a fresh review. Fail-closed, so not a safety bug; it is an availability/UX trap in the normal approve → log → sign-off rhythm. Consider ending the block at the fold (`## Log`) like `foldPlan` does.

## F8 — Supervisor 100k compaction silently disabled when `getContextUsage` is unavailable (Low) [INFERENCE]

`src/supervisor-session.ts:141-143`: `if (compacting || (ctx.getContextUsage()?.tokens ?? 0) < COMPACT_AT_TOKENS) return;`. If `getContextUsage()` returns undefined (RPC/print modes or any runtime where it isn't wired), tokens coerce to 0 and the supervisor never self-compacts, contradicting the AGENTS.md cost design ("compacts every 100k"). Pi's own auto-compaction will eventually fire without the custom instructions that protect the plan pointer and approval state. I could not confirm whether `getContextUsage` is ever undefined in the Herdr-pane interactive mode; in the test mock it is explicitly set.

## F9 — Plan-mode bash gate: residual holes are narrow but worth noting (Low) [CODE/INFERENCE]

`isPlanningReadOnlyCommand` (`src/index.ts:566-574`) is otherwise tight (blocks pipes/redirects/backticks/`$`, splits on `&&`/`;`, whitelists verbs, special-cases `--output`, `find -delete/-exec...`, mutating `git branch`). Residual issues:

- The whitelist allows `git log/show/diff` with *arbitrary* flags. `git diff --ext-diff` / `git log --ext-diff` execute the command configured in `diff.external`/`GIT_EXTERNAL_DIFF`. Env-prefix assignments are blocked (the part must start with a whitelisted verb), so this requires a pre-existing malicious `.git/config` in the target repo. [INFERENCE] that any real repo would have this.
- Plan mode blocks only `edit`/`write` by name (`PLAN_MODE_BLOCKED_TOOLS`, index.ts:34). Any other extension's mutating tool (e.g. a `process`/background-task launcher, `apply_patch`-style tools — the supervisor's own `WRITER_TOOLS` list at supervisor-session.ts:13 acknowledges several) is not blocked in plan mode. In the worker session all user extensions are loaded, so this depends on the user's setup. [INFERENCE]

## Non-findings (checked, working as intended)

- **Shutdown latch**: `GoalIntercom.stopped = true` on `session_shutdown` looked dangerous for in-process `/resume`, but Pi tears down and re-creates the ExtensionRunner (and therefore all extension instances) on resume/new/fork/reload (agent-session-runtime.js:102-112, agent-session.js:2053-2073). [TESTED against pi source]
- **Handler ordering**: Pi runs handlers sequentially in registration order and awaits them (runner.js:579-604), so `GoalIntercom`'s constructor-registered `session_start` (channel load) completes before index.ts's `configure` → hello. Per-handler errors are swallowed into `emitError` (this is why F1 is silent). [TESTED against pi source]
- **ApproveGoal freshness gates**: the `view === newest.text` equality check is sound — `sendUserMessage` stores the text verbatim (agent-session.js:1106-1133), `latestView` is set before `onView` fires, and any newer queued view makes the comparison fail closed. Worker "stopped"/`backgroundQuiet` are extension-computed (`ctx.isIdle()`, `backgroundState`), not model-controlled, so the worker model cannot spoof a stopped/quiet view. `backgroundState` fails closed ("unknown" → not quiet) when an installed tracker doesn't answer, and distinguishes missing providers (background.ts, covered by test/background.test.ts).
- **Approval checkpoint binding**: head/tree/clean-worktree/goal-block-hash equality plus per-`approvalId` binding and `beginReview`'s deletion of prior approvals make approval replay across plans or commits infeasible; `.pi/plan`, approvals, and model prefs are correctly excluded from the dirtiness check relative to repo root (`approval.ts:20-34`).
- **Steer/view redelivery after restart**: pending steers and `received` dedupe survive restart via session-entry replay (`intercom.ts:54-68`) and are covered by test/intercom.test.ts; ack cursors are monotonic.
- **Two-peer guard**: the "Two peers claim this supervision binding" throw fires before any state mutation and repeats harmlessly; it can wedge only if the broker failed to emit `session_left` for the previous peer, which the broker does send on disconnect/reregister (broker.ts:327,540).

## Test-coverage gaps relevant to the above

- No test exercises F1 (resume with unavailable remembered model).
- No test exercises a resumed worker whose supervisor never answers (F2) — the intercom fixture auto-replies to hellos, so `connected` is always true in tests.
- The native end-to-end test (test/native-intercom.test.ts) drives `SteerWorker` only; the `ApproveGoal` → approval file → `CompleteGoal` chain has never run through two real Pi sessions, so F7-class friction and the `view === newest.text` gate are unverified end to end.
