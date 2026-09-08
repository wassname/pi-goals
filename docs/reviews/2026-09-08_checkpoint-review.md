## Review

Reviewed the worker report, follow-up-only diffs under `/tmp/pi-goals-checkpoint-fix/`, corresponding current source/tests, and the parent’s final latch correction. The saved `before/` files separate this work from the previously reviewed implementation; this is not a re-review of the broader uncommitted changes.

- **Correct — fresh, immutable checkpoints:** `src/internal/supervisor/index.ts:362–396` captures a complete worker snapshot for each explicit review and rechecks request identity, cancellation, pairing generation, session identity and canonical-plan hash after capture. The branch is read after tracker queries in `captureWorkerView`. The snapshot replaces `worker_view` only when its checkpoint becomes active; routine updates cannot overwrite an active assessment. Covered by `test/internal-supervisor/plan.test.ts:73–168`.

- **Correct — current direction and bounded transport:** `src/internal/supervisor/view.ts:267–288` pins the latest non-supervisor user direction separately from older summaries, with explicit truncation. `src/internal/supervisor/protocol.ts:19–39` projects checkpoint identity into replies and bounds the actual serialized request, including JSON escaping and Unicode. Its size calculation matches the installed Intercom broker’s payload measurement. Success, duplicate rejection and failure responses omit the snapshot.

- **Correct — genuine settlement required:** `src/internal/supervisor/index.ts:899–908,1198–1215` records empty final output at `agent_end` but acts only at `agent_settled`, and only for an unresolved assessment. Successful verdicts and separately queued checkpoints are excluded. The installed Pi implementation emits settlement after retry, compaction and queued-continuation processing (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:744–781`). Nonempty human-question handling remains distinct.

- **Fixed by parent; verified read-only — failure incorrectly latched a human dependency:** The earlier `failAssessment` set `awaitingUser=true`, suppressing later ordinary worker views indefinitely. Current `src/internal/supervisor/index.ts:634–647` clears that latch and stale routine-refresh flags, then refreshes the footer. This permits later progress/cadence without immediately retrying the same dirty view, while retaining separately queued checkpoints. The two regressions at `test/internal-supervisor/plan.test.ts:188–203` fail in `wait-latch-red.log` and pass in `wait-latch-green.log`. Explicit `needs_user` and nonempty-question pause paths remain present.

**No issues found.**

**Merge verdict: OK with notes.** The scoped changes are approved. Parent-owned final aggregate validation and live-pane acceptance remain outstanding evidence, not established by this read-only review.

### Validation and residual risks

- Inspected saved worker results: **89 focused tests**, **169 supervisor tests**, **51 integration tests**, plus clean typecheck/lint. These precede the parent’s latch correction.
- Inspected parent’s post-correction regression log: **2 passed**, covering empty-final and provider-error recovery, no immediate retry loop, and subsequent ordinary progress.
- No commands, edits, Herdr operations, settings changes, staging or push were performed by this reviewer.
- Parent’s final `npm test`, typecheck, lint and build were starting; their results were not available for this verdict. Complete `npm test` before committing, as required by `AGENTS.md`.
- Live current-pane behavior and supervision quality/cost still require parent validation. Bounded snapshots can explicitly truncate; historical replay is not live acceptance.