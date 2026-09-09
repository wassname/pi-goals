# Worker compaction and recovery implementation evidence

Scope: safe `/goals` entry, bounded peer hello retries, pre-fork worker compaction, deferred Intercom delivery during compaction, and preserving a completed healthy pairing.

## Implemented behavior

- A bare `/goals` opens an action menu. An active plan is not replaced by unknown/free-text input; `/goals plan <objective>` is required, including when the objective happens to be named `restart`.
- The worker status displays `👁` only when the supervised Intercom pair is connected.
- An unanswered active binding emits the original hello plus at most two delayed retries (1 s and 5 s). The normal five-minute readiness/solo policy remains authoritative.
- Ready compacts the approved worker session before the worker model is restored and the supervisor pane forks it. Planning/resync and queued Intercom delivery do not append messages during that compaction. The supervisor already recognizes an inherited compaction entry and skips its initial compaction.
- A healthy completed pairing remains bound after sign-off. While the worker peer is absent, one identical steer is persisted once and replays after a successful reconnect; the tool result tells the supervisor not to repeat the instruction or produce a long recap.

## Validation

- `npx vitest run test/goals-flow.test.ts test/intercom.test.ts test/supervisor-session.test.ts` — passed: 3 files, 78 tests.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed before the final wording-only prompt change; final typecheck/lint passed after it.
- `git diff --check` — passed.
- `npm test` — 155/156 tests passed. `test/rpc-review.test.ts` repeatedly timed out waiting for its first `select` request after the offline model completed planning. This was also reproduced before the new lifecycle edits and was not changed here. The focused flow suite covers the changed paths, but this is a remaining test failure.

## Review notes

Static diff review checked command-word objectives (`/goals plan restart`), active-plan non-destructiveness, old binding preservation after completion, and pending-steer replay. No additional agreed defect found.

## Remaining gaps

No real Herdr/model acceptance was run (no panes used). The user-reported Copilot compaction timeout and long supervisor status loop were not reproduced with a real provider. A truly terminated worker cannot receive the retained instruction until the existing pairing is restored through reload/reconnect/restart.
