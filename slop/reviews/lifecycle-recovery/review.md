# Lifecycle recovery and role-aware commands

## Scope and decisions

Continue issue #6 and the independent lifecycle review after full-profile commit `1d52857`. Keep normal extensions/tools; do not alter Git/evidence approval policy. The supervisor approved delayed role selection at session_start, a durable inbound-message record, and requiring Pi 0.85.1 instead of maintaining a 0.84 compatibility retry layer. The user additionally authorized `work`, `supervise`, and `noplan` recovery commands.

`138bde5` already committed/pushed the first increment: CompleteGoal cancellation and Ready content stability. Remaining changes build on it, not replace it.

## Fixes

- CompleteGoal checks its signal before/after the asynchronous background lookup and before persistence; stale binding/version/phase or a disposed runtime also rejects. Cancelling one call leaves the plan active. `cancellation-before.txt` records a regression failure against the earlier implementation (it returned success after abort); the updated test verifies no tick/sign-off marker is written and a later valid call still works.
- Ready checks the displayed plan content before launch, after launch, after worker-model restoration and after the first view. A changed plan returns to planning using the existing pane; it does not start the changed implementation. Tests mutate content at launch and model restoration, then select Ready again without another pane.
- Real supervisor and worker sessions now select their role when session entries are available, before registering either role's handlers. A complete supervisor marker (worker, owner, plan path, approval binding) is written before model restoration/compaction. Persisted identity wins over launch environment. Legacy bootstrap markers migrate only with an existing pairing; incomplete records throw visibly without enabling worker mode. Stopped supervisor forks retain their identity. No tool denylist was reintroduced.
- Intercom saves each incoming non-started view/steer in a bounded inbox before calling Pi. It acknowledges only a matching user message_start. That is **session acceptance**, not model judgment or action execution. Unconfirmed payloads are restored from the active branch on reload; separate incremental views are retained rather than overwritten. A pending Pi queue is not re-enqueued while waiting for presentation. Completed/detached bindings and shutdown cancel delivery timers.
- Pi 0.85.1 has a public session_compact_failed event and fixes isIdle to include manual compaction; repo 0.84.1 did not. The minimum peer and exact dev version are now 0.85.1. Installation used `--ignore-scripts --no-audit --no-fund`; no global Pi change. Success/failure/cancel events resume retained context. Since session_compact precedes final controller cleanup, delivery waits for compaction-aware idle state; it never probes by sending a prompt during compaction. Waiting is bounded to 300 one-second idle checks with retained payload and a visible reconnect instruction on exhaustion, not a deadline that interrupts the model.
- Readiness/reconnect paths allow five minutes rather than five seconds. Reload while an inherited compaction is active waits for it rather than starting a second one. An existing last compaction or Pi's Already compacted/Nothing to compact result can proceed to bootstrap. Startup model/compaction failure is communicated through the existing hello so the worker sees the cause promptly. A later ready hello clears the failure.
- An established worker pairing republishes one fresh current view when disconnected→connected, including after supervisor-only reload where the old stopped view had already been accepted. This reuses the connection callback; Ready retains its own initial publication and session_start/reconnect no longer separately publish duplicates. Cleared/completed sessions do not restart monitoring.
- A started-worker view now reports that work is running instead of falsely claiming a newer review is queued for delivery.

## Command meanings

- `/goals work`: existing approved worker session reconnects its saved pairing/model; no new plan, pairing or model fallback. Missing/unapproved pairing is rejected.
- `/goals supervise`: existing saved supervisor reconnects its role/model/pairing. Running it in a worker session is rejected rather than converting the role.
- `/goals noplan`: leave planning restrictions and preserve the draft/history without Ready, implementation, supervisor launch or file deletion. In-flight Ready is invalidated. It does not claim the retained draft was approved.
- `/goals reconnect` remains generic recovery; `/goals restart` explicitly replaces only the tracked pane and invalidates the prior binding; `/goals clear` closes/disconnects while retaining the plan file.

## Runtime validation actually observed

`native-validation.txt` is fresh verbose output from installed Pi 0.85.1 with a local deterministic HTTP model; no credentials or model credits used.

1. Real Pi worker and supervisor delivery during manual compaction: success, local model failure and cancellation, six cases total. Each retained payload is presented exactly once and saved in the session; no extension_error events. The transport in this fixture is deterministic, while Pi owns the real compaction and prompt lifecycle. Success uses an extension-provided summary; failure exercises Pi's HTTP summarization failure. These are not rendered Herdr sessions or 60-second real-model runs.
2. Real native Pi/Intercom pair: full-profile discovery in an isolated agent directory, exact steering delivery, then supervisor termination and fresh-shell `--session` resume with role/binding launcher environment removed. The resumed model sees SteerWorker/ApproveGoal and the discovered profile tool, not CompleteGoal, and retains the supervisor opening. No second supervisor pairing is constructed.

Hook tests additionally cover a simulated 60-second inherited compaction without competing compaction, five-minute Ready/reconnect patience, immediate reported failure plus rejoin, retained distinct deltas through reload, delayed presentation without duplicate enqueue, role migration/incomplete identity, cancelled completion, Ready content drift, and command semantics. Existing paired tests cover symmetric reconnect/model restoration. The accepted-view reconnect regression checks one new view ID and unchanged-payload replay deduplication separately; cleared/completed pairings produce no new view. The tests model `/reload` with new extension instances or saved state; no real interactive `/reload` command was exercised in this task.

Final `validation.txt`: 123 tests in 22 files, typecheck, lint, build, and diff check pass. Native fixture initially could not compact a single retained turn; it now seeds two sufficiently sized turns. This corrected fixture setup is not counted as a product failure. No test processes from earlier runs remained when resuming after timeout; all processes started by these tests were shut down.

## Limits and remaining acceptance

The parent must still run full-profile Herdr acceptance: actual reloads in both orders, drafting/Ready/checkpoint interruption, stopped pair resume, real-model long compaction, and an unmet-outcome correction followed by both sign-offs. Automated session acceptance does not establish judgment quality or cheaper-worker success.

The inbox holds at most 64 messages; overflow is visible and unacknowledged. Arbitrary extensions that rewrite or consume injected user messages can defeat exact-text acceptance matching; crashes between message_start and message persistence can require review/replay. This is not an exactly-once execution guarantee or a general durable model queue. Role instructions remain the only prohibition on supervisor writes. Existing all-cancelled completion behavior and Git-tracked verification policy are unchanged.

No user or test Herdr panes, research sessions, human journal, or pre-existing dirty native evidence logs were operated/read/edited by this task. Changes to package-lock reflect the approved local Pi dependency upgrade. This report does not claim all issue #6 behavioral acceptance is complete.
