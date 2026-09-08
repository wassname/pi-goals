# Intercom supervision and selected feature transfer

User priority: pi-intercom is the session-to-session transport. Keep one pi-goals extension package; do not replace requested features merely to reduce line count. Existing worker and supervisor panes are off-limits.

- [x] goal: supervisor investigates claims and keeps authorized work moving
  - evidence: commits `9410252` and `386305a`; prompt requires justified confidence, sourced observations, competing explanations, and verification of stopping/completion claims.
  - limitation: prompt checks do not prove behavioral improvement.
- [/] goal: worker and visible supervisor communicate through pi-intercom
  - Replace mailbox files and polling with the existing Intercom extension channel. No separate RPC transport or mailbox fallback.
  - Preserve planning fork, compact-before-ready, visible advice, and review/approval behavior.
  - failure modes: false readiness, duplicate delivery, wrong-session routing, stale callbacks after reload, disconnected peer treated as active.
  - deliverable: isolated two-session message transcript with exact instructions received, reconnect/reload checks, and saved validation output. Do not operate user panes.
  - evidence: [37 passing tests, typecheck and lint](../reviews/20260908-intercom-validation.txt). Two client sessions exchange readiness, view, and exact advice through a real isolated Intercom broker. Lifecycle mocks cover resume/deduplication. Mailbox source and polling were removed.
  - evidence: [native Pi-pair validation](../reviews/20260908-native-intercom-full-validation.txt) reports `Tests 46 passed (46)` plus successful typecheck, lint and build. The isolated production supervisor forks planning context and sends exact advice through Intercom to a real Pi worker using a transport fixture. [Supervisor events](../reviews/native-intercom/supervisor-events.jsonl) show `SteerWorker` and the worker acknowledgement; [worker events](../reviews/native-intercom/worker-events.jsonl) show the received user message. Both saved stderr files are empty.
  - limitation: this deterministic test proves transport and context retention, not useful model judgment. The worker fixture does not exercise the full Ready path. Rendered Herdr two-pane acceptance and fresh-shell supervisor resume without launcher environment remain unverified.
- [x] goal: supervisor receives a useful bounded worker overview
  - Borrow latest human direction, source-session path, and incremental progress from `origin/feature/simple-visible-supervision`.
  - failure modes: lost authorization, repeated summaries, truncated evidence treated as complete.
  - deliverable: saved before/after overview fixtures covering compaction and changed human direction.
  - evidence: [generated fixture views](../reviews/20260908-worker-overview-example.txt) retain the human direction while omitting acknowledged old detail. [43-test validation](../reviews/20260908-worker-overview-validation.txt) also checks compaction reset and serialized Unicode limits; fixture content is synthetic, not a model performance claim.
- [x] goal: supervisor distinguishes agent idleness from tracked background work
  - Borrow existing process/subagent tracker queries; report unavailable trackers as unknown.
  - failure modes: approving while a tracked job runs, treating a local queue as a dependency of remote work.
  - deliverable: idle/running/unknown status cases and a blocker-diagnosis scenario.
  - evidence: the same validation log checks active and unavailable tracker reports and rejection of approval with unknown background state. Actual independent diagnosis of the queue mistake remains a behavioral acceptance task.
- [x] goal: role model choices persist
  - Borrow planning/worker/supervisor model preference behavior without changing active user settings.
  - failure modes: automatic model changes overwrite user choices; a missing model silently substitutes another.
  - deliverable: isolated preference restoration and explicit unavailable-model errors.
  - evidence: [45-test validation](../reviews/20260908-role-model-validation.txt) restores three distinct role choices, ignores automatic restore events, and leaves an unavailable saved choice unchanged. Preferences are project-local; active user settings were not edited.

## Verification

Run project tests, typecheck, and lint before commits. Preserve full command output. Keep each feature in a separate commit where practical and push finished changes. Inspect the transferred code rather than equating tests or source size with quality. Keep the requested independent evidence judge when combining implementations; do not silently remove it.

The earlier asynchronous subagent failure (missing pi-client/unix) prevented the original review. A later parent retry completed independent review run `5c8c2017-a92f-4a5f-baf6-f441f9b50495`; its [findings are preserved with attribution](../reviews/20260908-independent-supervision-bug-review.md). Behavioral acceptance requires observed useful judgment, not merely matching prompt strings. Cost savings require a measured comparison and remain unproven.

## Independent review follow-up

- [x] Verify F1/F2/F4 lifecycle failures and implement explicit recovery without fallback models or automatic pane replacement.
- [x] Address F3 inactive bindings and preserve synchronous handoff-before-ack ordering. Pending transport frames retry; end-to-end durable delivery is not guaranteed.
- [ ] F3 deeper delivery confirmation: Pi's void adapter can ack before an asynchronous enqueue failure. Future UAT must inject that failure, avoid reporting confirmed model delivery, and keep the instruction recoverable. See the [SDK source-backed limitation](../reviews/20260908-review-fixes.md). Parent approved keeping this protocol expansion out of the current fix commit.
- [x] Remove F5 general Intercom actuator, reject F6 nested placeholders, and correct F7 goal/log hashing boundary.
- [x] Add focused regressions and inspect final full test/typecheck/lint/build output. [57-test evidence](../reviews/20260908-review-fixes-validation.txt); [initial child-environment failure and correction](../reviews/20260908-review-fixes-initial-validation.md).
- [ ] Parent independent post-change review before push. F8/F9 limitations and remaining native/UI/behavioral gaps are explicit in the [finding-by-finding disposition](../reviews/20260908-review-fixes.md).

Recovery operations were exercised only with isolated mocks/native test processes; existing user panes were not operated. Implementation worker commits locally only; parent owns review and push.

-- Pi/OpenAI
