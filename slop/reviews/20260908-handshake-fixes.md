# Post-review P1–P5 fixes — Pi/OpenAI implementation worker

Baseline: `1668c94`. Independent review: [attributed, preserved source](20260908-independent-post-fix-review.md), reviewer run `bdb93a2e-52f4-4a6d-bac2-7c9eb48118b5`.

Read AGENTS.md and installed Pi extension docs for lifecycle teardown, commands, model selection and compaction before editing. No user pane/session was operated; tests use isolated mocks/brokers/native Pi processes. No nested delegation or push.

## Dispositions

- **P1:** Replaced change-gated hello replies with an explicit request/reply bit. Every request receives one reply even when the peer state is unchanged; a reply never elicits another hello. Each successful exchange retries only still-pending instructions/current view, including after either side's own readiness transition. Repeated wire frames are allowed and deduplicated at the receiving adapter; this is not a new durable-delivery claim. `test/intercom-handshake.test.ts` wires **two real GoalIntercom adapters**, not an auto-ready peer. It checks repeated worker and supervisor reconfiguration, concurrent reset (four hello frames), single-sided reset (two frames), exact advice handoff, own-ready pause/resume, pending advice/view replay, and reconnect deduplication. Both peers must load the updated transport; mixed-version reconnect is not claimed supported.
- **P2:** The worker configures not-ready during startup/recovery. Startup can await peer readiness without claiming implementation readiness. It announces ready only after worker model restoration and the phase transition to working. Model failures remain not-ready. The Ready/retry flow test uses the same two real adapters and proves unavailable worker model → not-ready → `/model` + reconnect → Ready → working on the **same** binding/pane, followed by successful advice after healthy reconnect. Planning reconnect alone does not authorize implementation.
- **P3:** A known peer with incomplete readiness is distinguished from an absent peer. Guidance points to the supervisor pane's compaction/model diagnostics and `/model` + `/goals reconnect`, rather than treating every pause as disconnection. Regression checks widget and prompt guidance.
- **P4:** `src/plan.ts` now owns the single goal-line and Log-fold definitions. Widget scanning, subtasks, goal ticking and approval use the same current-plan boundary. Tick still rejects duplicate active-region matches; historical Log copies remain byte-for-byte unchanged. The existing approval/sign-off flow now includes duplicate/historical goal lines in the Log, succeeds and ends the active plan instead of reopening historical goals.
- **P5:** Detach/reconfigure immediately reject old readiness waiters. A small Ready-attempt identity plus plan-version guard invalidates asynchronous startup results on clear/recovery/replacement; stale menu/editor responses are also ignored. Regressions clear while the five-minute initial wait is pending (no clock advance needed to settle), then advance five minutes and verify no resurrection; a second test clears before the launcher callback resolves and verifies no late binding/pane persistence or work launch. No automatic late-pane kill was added.
- **F8 observability:** One warning per runtime if the entire usage result is unavailable at a settled check. No warning for Pi's ordinary post-compaction `tokens: null` sample. No speculative token estimator, new compaction policy, or change to Pi auto-compaction. Persistent null usage still cannot trigger the custom 100k check.

## Verification and changed old assertions

[Full successful commands/output](20260908-handshake-validation.txt): **67 tests passed in 17 files**, followed by successful typecheck, lint, build and `git diff --check`. The exact main-session test command unsets `PI_SUBAGENT_CHILD` and `PI_GOALS_ROLE` and sets a **fresh explicit** `PI_GOALS_EVIDENCE_DIR` to `slop/reviews/handshake-native`.

Two intermediate failures are preserved, not counted as passes:

1. [Handshake-focused run](20260908-handshake-initial-validation.txt): 26 passed/1 failed. The old assertion demanded exactly one outbound wire retry after configure+markReady. These now generate separate request/reply exchanges, which can retry the same still-unacked id more than once before its ack. Updated assertion requires at least one retry, every retry's exact id/text, and no further retries after ack. Two-real-adapter tests independently require exactly one user handoff/view callback after duplicate wire delivery.
2. [First full boundary run](20260908-handshake-boundary-initial-validation.txt): 65 passed/1 failed. Its old duplicate-goal fixture appended the duplicate **below `## Log`**, precisely the P4 behavior being corrected. The duplicate-rejection test now inserts the duplicate above the fold and still requires null; an added test requires historical copies below the fold to be ignored and unchanged.

An intermediate typecheck passed; lint initially flagged import order and a nested assignment. Those were corrected; the full final lint passed with no fixes applied.

[Native log inspection](20260908-handshake-log-inspection.txt) reads the final worker/supervisor event files, verifies zero error records and empty stderr, and matches the outgoing instruction, worker incoming instruction and adapter ack id `22068654-6e7c-4328-890f-9382b25c8ea7`. The worker user message is exactly `[supervisor] Read the real outputs before declaring completion.` This deterministic native test proves context retention/routing/tool exposure, not autonomous judgment or durable enqueue guarantees.

## Evidence provenance caveat

At the first inspection, these two tracked files were **already dirty**:

- `slop/reviews/review-fixes-native/supervisor-events.jsonl`
- `slop/reviews/review-fixes-native/worker-events.jsonl`

The inherited `PI_GOALS_EVIDENCE_DIR` pointed there. The first full test run accidentally refreshed them again. Their pre-task uncommitted bytes were not captured, so it is not established that all differences from HEAD were produced by this worker. They are left **unstaged and uncommitted**, not restored over unknown prior edits. The refreshed copies were separately preserved under this worker's output directory, `scratch-refreshed-prior-evidence/`. Final evidence uses only the fresh `handshake-native/` directory and is not mixed with these prior paths.

## Still open / acceptance limits

**F3 async enqueue confirmation remains open.** Pi's void `sendUserMessage` wrapper can return before a later async enqueue rejection. An adapter ack is not durable enqueue, model receipt, or execution confirmation. No correlated-receipt protocol was added; the future forced-async-rejection UAT remains required. A synchronous handoff failure still remains unacked for retry.

Parent/reviewer owns independent post-change review and push. Rendered Herdr acceptance, the complete two-native-session ApproveGoal → CompleteGoal chain, fresh-shell role recovery without launcher environment, useful independent judgment and cost savings remain unproven. Planning/pause shell gates remain trusted-repo guardrails, not a security sandbox. If a pane split finishes after cancellation, it can remain untracked for human inspection; this change prevents stale state resurrection rather than operating a late pane automatically.
