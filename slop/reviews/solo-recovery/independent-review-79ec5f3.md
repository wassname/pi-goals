# Independent review: 79ec5f3 "Continue approved goals with loud solo recovery on supervisor failure"

Base: `15dd7f0`. Reviewed diff, full `src/index.ts`, `src/intercom.ts`, `src/supervisor-session.ts`, `src/herdr.ts`, `src/command-help.ts`, `src/prompts.ts`, test changes, and `slop/reviews/solo-recovery/review.md` + validation files as claims to verify. Read-only repo; no panes, research sessions, installs, journal, commits, or edits. Reproductions ran in an isolated `/tmp` copy with `PI_SUBAGENT_CHILD`/`PI_GOALS_ROLE` unset and `PI_GOALS_EVIDENCE_DIR` redirected to `/tmp`. The unrelated dirty `slop/reviews/review-fixes-native/*.jsonl` logs were preserved (sha256 matched `context.txt` before and after). This is not real Herdr acceptance.

## Verified claims (reproduced)

- `env -u PI_SUBAGENT_CHILD -u PI_GOALS_ROLE PI_GOALS_EVIDENCE_DIR=/tmp/... npx vitest run`: **22 files / 138 tests pass**, matching `validation.txt`. The `fatal: not a git repository` stderr is indeed from the negative preflight regression.
- `getArgumentCompletions` / `AutocompleteItem.description` are real Pi 0.85.1 API (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:895`) and are wired into interactive-mode slash commands. The per-verb worker/supervisor completion split works and returns `null` (no interference) for objectives.
- Authorization rules hold in code and tests: solo fallback after Ready only fires when the exact displayed plan still matches after all waits *and* the worker model restores; changed plan, `noplan`/cancel, unapproved draft, repository preflight failure, and worker-model failure all return to planning/notify instead (`src/index.ts` Ready branch; test `never uses initial supervisor failure to approve a %s Ready attempt`). No approval is inferred from draft, cancellation, changed plan, or model error.
- Persisted `mode`/`soloReason` restore on `session_start`; legacy entries without `mode` default to `supervised`. `CompleteGoal` rejects in solo (including an in-flight call via the post-await binding/version re-check). `/goals reconnect` in solo restores only the worker model and stays solo. `/goals restart` restores `supervised` only after successful close+launch+readiness; a failed replacement stays loudly solo. A late old-peer hello after detach is dropped (binding mismatch) and cannot silently restore supervision. Terminal worker-model errors after Pi recovery pause work and never enter solo. Supervisor-side settled model errors call `failReady` only after Pi retries; transient `agent_end` errors alone do not demote. Continuation after solo entry is real: a persisted display message plus a `followUp` user message resume the worker.
- The five-minute window behaves as claimed at startup/resume/disconnect boundaries, including transient-reconnect-within-window staying supervised (test `shows a missing resumed supervisor...` updated expectations).

## Findings

### F1 — Medium-low (reproduced): a Herdr close failure during `/goals restart` is misclassified as a supervisor failure and demotes a *healthy* supervised pairing to solo

`src/index.ts:496` wraps `stopSupervisor()` failure in `SupervisorFailure`, and the catch at `src/index.ts:518` routes any `SupervisorFailure` in a working phase to `enterSolo(...)`. This contradicts the class's own contract (`src/index.ts:87`: "Only launch/readiness failures authorize fallback, not local model, plan or repository errors") — a Herdr socket/close error is a local environment failure, not a supervisor launch/readiness failure.

Reproduced in the isolated copy with the repo's own flow-test harness (`closeSupervisorPane.mockRejectedValueOnce(...)` on a healthy connected pairing, then `/goals restart`): resulting state is `{ mode: "solo", approvalId: null, supervisorPaneId: "owned-pane" }` with the "UNSUPERVISED WORKER ... Could not close the tracked supervisor pane" notification. Consequences: the live binding is detached while the still-healthy supervisor pane remains open and abandoned; `CompleteGoal` is blocked until a further restart succeeds; each retry must first succeed at the same close that just failed. Before this commit the same failure was a plain error with a notify and no mode change.

Minimal fix: at line 496 throw a plain `Error` (as before) instead of `SupervisorFailure`, so the catch notifies "Goal recovery failed ... use /goals reconnect to retry" without entering solo. If solo-on-failed-replacement is desired only for genuine launch/readiness failures, that behavior is unchanged since `startSupervisor`/`waitSupervisor` still throw `SupervisorFailure`.

### F2 — Low (inferred from code): the abandoned supervisor pane keeps showing "supervising" and `SteerWorker` silently no-ops after the worker enters solo

`enterSolo` (`src/index.ts:201-213`) calls `intercom.detach()`, and `detach()` clears `this.binding` *before* calling `this.hello()`, so no final message is published on the old binding. The old supervisor session retains the stale `peer`/`peerReady`; its `connected` getter is channel-level, so its new status line reads "supervising" and `SteerWorker` publishes without error while the worker drops every message on the binding-mismatch check in `intercom.ts` `receive`. Loudness is worker-side only; the visible supervisor pane misrepresents the pairing until `/goals restart`/`clear` closes it. Minimal fix: in `enterSolo`, before `intercom.detach()`, publish one final `hello` (or dedicated message) on the old binding carrying a failure/reason such as "worker entered solo mode; pairing detached" so the pane flips to paused and steering errors surface.

### F3 — Low (code-read, cosmetic): solo widget still says "awaiting supervisor review" for claimed goals

`src/index.ts:431` renders manually ticked goals as `? claimed complete; awaiting supervisor review: ...` even in solo mode, where no review can arrive; only the unshifted UNSUPERVISED line (line 432) contradicts it. Minimal fix: in solo, render these as `? claimed complete; unreviewed (solo): ...`.

### F4 — Low (inferred): every `/goals` invocation overwrites the command token and silently cancels an in-flight reconnect/restart

`commandAttempt = command` runs at the top of the handler (`src/index.ts:448`) for *all* verbs, including no-ops (`/goals supervise` in the worker, `/goals solo` during planning, `/goals work` with no pairing). The in-flight reconnect/restart's `current()` then fails and it returns silently — no notification that the recovery was cancelled. Realistic scenario: user mistypes `/goals supervis` while a restart is inside its five-minute readiness wait; the restart dies quietly and the pairing stays paused. Minimal fix: assign `commandAttempt` only inside the reconnect/restart branch (and other branches that intentionally supersede), or notify when an in-flight recovery is cancelled.

### F5 — Informational

- `supervisor-session.ts:98` calls `statusContext?.ui.setStatus(...)` during `session_shutdown`; whether Pi tolerates `setStatus` after UI teardown is unverified (mocked in tests). Low risk, unflagged as a bug.
- Solo reasons built with `String(error)` carry an `Error: ` prefix (`src/index.ts:223`); cosmetic.
- Design consequence (documented in README, within the stated authorization): any transport-level disconnect not recovered within five minutes converts to solo even if the supervisor process is healthy, and an explicit peer `failure` hello ends the wait with zero recovery window. Both are loud and reasoned; flagging only so the trade-off is conscious.
- Unnecessary-complexity note: three overlapping cancellation tokens (`readyAttempt`, `recoveryAttempt`, `recoveryCommand`/`commandAttempt`) guard adjacent async spans; F4 is the concrete cost of the third one. `intercom.onSteer`'s new `state.mode === "solo"` guard is redundant (the detached binding already drops steers) but harmless.

## Remaining functional gaps (agree with review.md's own boundary)

- No real-Herdr, real-model acceptance is claimed here or by the commit: rendered loud fallback, per-verb completion display, actual useful worker continuation quality after solo, both reload orders, restart-back-to-supervised, and a real ApproveGoal → CompleteGoal cycle in parent-owned test panes remain unverified.
- The five-minute window is not a liveness watchdog: an alive-but-hung supervisor that keeps reporting ready still requires explicit `/goals solo` or `/goals restart`.
- Continuation delivery relies on Pi's messaging API; no exactly-once guarantee (acknowledged).
- `native/` evidence covers the pre-existing fork/resume path only; it is not evidence for the new fallback behavior.
