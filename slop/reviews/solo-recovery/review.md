# Solo recovery implementation review

Base revision: `15dd7f02225d366ae920509bb23066be83956fb8`. Tested with installed Pi 0.85.1. No user panes, worker/supervisor research sessions, or human journal were operated on/read. Pre-existing dirty native event files remain untouched; their hashes are recorded in context.txt and matched after validation.

## Implemented semantics

- A persisted `mode: supervised | solo` and `soloReason` accompany the existing working phase. Older saved working states default to supervised. Solo keeps plan version/content, evidence and previous sign-offs, but detaches the old binding and makes all further CompleteGoal calls unavailable. Manual checkboxes remain claims.
- `/goals solo` requires an already-working/approved plan and a healthy restored worker model. It explicitly announces the reason and transition, preserved plan/evidence, unavailable supervisor sign-off and `/goals restart` recovery. Both a displayed saved message and a worker continuation message accompany the notification/widget. No goal completion is synthesized.
- An absent/not-ready supervisor gets the existing five-minute Intercom readiness opportunity. Work is gated while waiting. A return within that window stays supervised. A timeout gives the known timeout reason, not a guessed underlying cause, and enters solo. An explicit peer failure ends the readiness wait early with that exact reason.
- Supervisor model errors are reported only at `agent_settled`, after Pi's automatic retries/compaction have finished, not immediately on a failed attempt. Ordinary tool errors and recoverable manual-compaction failures alone do not demote a viable supervisor.
- Explicit initial Ready is human approval: a supervisor launch/readiness failure can enter solo only after the exact displayed plan is rechecked across the waits and worker-model restoration succeeds. Cancellation, changed draft, unapproved draft, repository/session preflight failure and worker-model failure never become solo through that path.
- Worker model failures, including terminal runtime errors after Pi recovery, remain paused; this does not substitute models or reclassify worker errors as supervisor failures.
- `/goals restart` closes only the tracked pane, creates a new binding and restores supervised mode only after successful startup/readiness. Failed supervisor replacement remains loudly solo; missing worker model remains gated. `/goals reconnect` in solo restores only the worker model and explicitly stays solo. A late old peer never silently changes mode.
- Argument autocomplete uses Pi's documented `getArgumentCompletions` and `AutocompleteItem.description`; workers and supervisors see descriptions appropriate to their commands. No custom tooltip UI was added.
- Worker status says supervised worker or UNSUPERVISED. Active worker goal lines say working, not supervising. Supervisor status says supervising, starting/reconnecting or paused and is cleared on shutdown.

## Validation

Final `validation.txt`: 22 test files / 138 tests passed; typecheck, lint, build and diff whitespace checks passed. The expected `fatal: not a git repository` stderr is from the negative preflight regression that removes the isolated test repository's .git directory; that test passes by verifying it does not authorize solo.

Focused regressions cover explicit solo, retained plan/state across reload and compaction, in-flight/future sign-off rejection, return through restart, replacement failure/cancellation, five-minute startup/resume/disconnect boundaries, transient reconnect, exact peer failure, worker-model startup/runtime failure, rejected changed/cancelled/unapproved Ready attempts, repository preflight rejection, command descriptions and supervisor role/status plus retry-aware failure reporting. Prior cancellation, content-change, native fork/profile, fresh-shell identity, native compaction and RPC review tests still pass.

`native/` saves deterministic real-Pi full-profile fork/resume messages/stderr from the existing native test. These establish no regression in that path, not functional proof of the new fallback behavior. `validation-initial.txt` retains the earlier stale status-assertion failure; the assertion was updated for the intentional supervised-worker label. An earlier development npm test also exposed inherited PI_SUBAGENT_CHILD=1 interfering with the RPC planner; final tests unset role/child variables and redirect native evidence into this fresh directory.

## Functional gaps / acceptance boundary

Parent-owned real-model Herdr acceptance remains required: inspect loud fallback and per-verb descriptions in the rendered terminal, see actual useful worker continuation after supervisor failure, inspect artifacts/evidence, test both reload orders and restore supervision through restart, then complete actual ApproveGoal -> CompleteGoal. Automated flow tests exercise fallback with small API mocks; no autonomous artifact result or full interactive fallback/recovery success is claimed here.

The five-minute readiness window is not a liveness watchdog for a peer that continues to claim ready. An alive but hung/stalled supervisor with no reported failure still requires judgment or explicit `/goals solo`/`restart`. This change does not infer failure from slow thinking, queued jobs, ordinary tool errors or lack of advice. A failed pane remains inspectable until explicit restart/clear. Solo mode is persisted, but delivery of the continuation still relies on Pi's public messaging API; no new delivery framework or exactly-once guarantee was added.

Independent parent/reviewer acceptance is pending. Implementation is committed for review, not pushed.
