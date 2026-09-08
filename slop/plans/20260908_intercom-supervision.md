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
  - evidence: [37 passing tests, typecheck and lint](../reviews/20260908-intercom-validation.txt). Two client sessions exchange readiness, view, and exact advice through a real isolated Intercom broker. Lifecycle mocks cover resume/deduplication. This is not yet a full live Pi-pair test. Mailbox source and polling were removed.
- [ ] goal: supervisor receives a useful bounded worker overview
  - Borrow latest human direction, source-session path, and incremental progress from `origin/feature/simple-visible-supervision`.
  - failure modes: lost authorization, repeated summaries, truncated evidence treated as complete.
  - deliverable: saved before/after overview fixtures covering compaction and changed human direction.
- [ ] goal: supervisor distinguishes agent idleness from tracked background work
  - Borrow existing process/subagent tracker queries; report unavailable trackers as unknown.
  - failure modes: approving while a tracked job runs, treating a local queue as a dependency of remote work.
  - deliverable: idle/running/unknown status cases and a blocker-diagnosis scenario.
- [ ] goal: role model choices persist
  - Borrow planning/worker/supervisor model preference behavior without changing active user settings.
  - failure modes: automatic model changes overwrite user choices; a missing model silently substitutes another.
  - deliverable: isolated preference restoration and explicit unavailable-model errors.

## Verification

Run project tests, typecheck, and lint before commits. Preserve full command output. Keep each feature in a separate commit where practical and push finished changes. Inspect the transferred code rather than equating tests or source size with quality. Keep the requested independent evidence judge when combining implementations; do not silently remove it.

The asynchronous subagent runner is unavailable (missing pi-client/unix). The user authorized direct implementation. Do not claim an independent review was run. Behavioral acceptance requires observed useful judgment, not merely matching prompt strings. Cost savings require a measured comparison and remain unproven.

-- Pi/OpenAI
