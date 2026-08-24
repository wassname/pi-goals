# Plan flow and judge review

- [x] goal: Each new `/goals` draft uses a fresh session-plan version
  - [x] Persist the selected `-vN` name so resume, reminders, Ready, and sign-off use one file.
  - [x] Keep earlier versioned files unchanged.
  - [x] Reserve `--clear` and `--judge` for commands so normal objectives are always new drafts.
  - failure mode: a second `/goals`, including an objective that begins with `judge`, changes the earlier plan or does not make a draft.
  - deliverable: [goals-flow.test.ts](../../../test/goals-flow.test.ts) shows an unchanged legacy file and `v1`, new `v2`, and `judge the vendor options` in new `v3`.
- [x] goal: Plan review asks and displays the needed context
  - [x] Add `Grill me` to the Ready menu and queue an understanding-check interview turn.
  - [x] Keep one short goal subject with its full indented context block.
  - [x] Keep visible plan output before the Ready dialog.
  - failure mode: Grill me starts work or the plan is only hidden in an edit call.
  - deliverable: [goals-flow.test.ts](../../../test/goals-flow.test.ts) records display before dialog and the grill follow-up.
- [x] goal: Judge review is visible without being confused with agent evidence
  - [x] Require concise observed checks before the verdict.
  - [x] Save the full judge reply under a unique path and link it from the plan log.
  - [x] Accept a headed check list with normal Markdown spacing, but reject an accept with no list.
  - failure mode: provider-private reasoning is claimed as evidence, the review is not inspectable, or a correct judge reply is rejected for blank-line formatting.
  - deliverable: [decide-signoff.test.ts](../../../test/decide-signoff.test.ts) locks the checked-artifact review contract, including a Markdown heading and blank line before the verdict.

## UAT / Verification

Observed 2026-08-24: `npm test` reported `Test Files  6 passed (6)` and `Tests  22 passed (22)`.
`npm run typecheck`, `npm run lint`, and `git diff --check` exited 0. The focused flow test proves
plan versioning, visible plan-before-dialog ordering, Grill me behavior, and objectives beginning
with `judge`.

## Appendix (context, not approved)

Issue #1 has a 600 second judge timeout now. The judge stays a separate read-only `pi -p --no-session` subprocess. Intercom is unsuitable because it has no equivalent isolation boundary.

External review: [Kimi K3](../../reviews/pi-goals-kimi-k3.md) found the command-prefix, check-list formatting, and transcript-path defects; all were fixed. [Grok 4.6](../../reviews/pi-goals-grok-4-6-retry.md) confirmed the check-list concern. Its Grill me concern does not apply: `skipReadyMenu` suppresses the menu after the generated follow-up, and the next `agent_end` follows the human reply.
