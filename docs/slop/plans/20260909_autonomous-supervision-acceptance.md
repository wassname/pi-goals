# Autonomous supervision and two-goal acceptance

User requested the other branch's better instructions, manual-checkmark handling, and a completed real trial. Keep the current reliability base and VCC. Do not import Git cleanliness, commit, or ignored-output approval gates.

- [ ] goal: Keep useful supervision running without invented human waits
  - Adopt the latest `565b272` prompt structure: stage-specific check-ins, outcome-first tool guidance, a clear distinction between recap and sent instruction, applicable AGENTS/skills, and short review context versus full orientation. Keep current-plan freshness and checkpoint evidence.
  - Preserve the earlier adopted behavior: investigate blockers, change ineffective steering, keep authorized independent work moving, inspect the result, and give brief visible judgments.
  - Take the new VCC adapter safeguards: separate budgets for extracted context/recent actions, partial-call handling, and explicit omitted-result/reference notices. Keep the current recovery and coalescing implementation.
  - Remove the assumption that ordinary prose without a verdict tool means a human decision is needed. New worker direction must reach the supervisor even after a real question.
  - failure modes: normal prose silently stops reviews; alternatively, failure causes an immediate retry loop or the supervisor ignores an explicit user pause.
  - deliverable: focused regressions for ordinary prose, empty/error responses, subsequent worker updates, genuine user pauses and no idle loop.
- [ ] goal: Treat manual completion marks as claims while retaining artifact-based review
  - Keep unsigned manual `[x]` claims visible and supervised, including reload. CompleteGoal remains the sign-off path; preserve independent judge policy and current plan identity/cancellation protections.
  - Git status is review context, not an acceptance gate. Ignored output files may be evidence. Do not force commits or cleanup.
  - failure modes: a manual tick ends supervision; dirty/ignored artifacts are rejected merely due to Git status; legitimate signed-off goals reopen on reload.
  - deliverable: widget/lifecycle/sign-off regressions, including dirty worktree and ignored-output cases.
- [ ] goal: Finish a real two-goal workflow with the chosen implementation
  - Carry relevant user preferences and the other branch's actual-Herdr testing procedure into AGENTS.md. Ask material questions, not a quota; retain ordinary-chat Discuss.
  - Run the functional trial with full normal Pi profiles, isolating only candidate pi-goals selection, and different worker/supervisor models. Inspect both panes and actual artifacts; do not substitute bundled-only loading or test counts for acceptance.
  - Exercise worker/supervisor/both reloads, fresh-shell resume, drafting/Discuss, Ready/startup, pending completion and stopped sessions. Preserve plan/role/peer; interrupted decisions need a visible retry path, not stale acceptance, duplicate panes or a permanent wait.
  - Diagnose failures from exact logs, fix them and retry; after prompt changes use a fresh task. Do not do the worker's artifact work for it.
  - failure modes: only unit tests pass; one goal is left unsigned; fabricated logs pass as execution; operator repairs are described as autonomous success.
  - deliverable: saved logs and pane evidence of both CompleteGoal results, actual output verification, interventions, remaining limitations, and separate role usage.

## UAT / Verification

- Success: both artifacts match the task, real verification output exists, both sign-offs are observed, and the same pair remains active between goals.
- Likely failure: startup/reload/approval stalls. Read both panes and the error, repair the cause, then repeat that stage.
- Sneaky failure: manual checkmarks or handwritten output appear complete. Inspect the underlying artifact and actual execution record, not just the widget or worker summary.
- Include an ignored output directory and preserved unrelated dirty file; neither should force a commit or block valid completion.
- Keep original sessions/settings untouched. Temporary changes to the three non-secret role preferences require guarded restoration. No release, merge, or active-installation replacement.

Recorded by Pi (OpenAI). [Earlier implementation validation](../../reviews/2026-09-09_autonomy-validation.md) remains a source check, not functional acceptance. The user has since disabled the sandbox and authorized the latest prompt/VCC adoption. pi-subagents was upgraded from 0.62.0 to 0.66.0 with a command-only release-age exception; other direct package versions and the default policy were unchanged. After reload, prioritize the real two-goal trial. Review suggestions for the other branch are posted in [issue #6](https://github.com/wassname/pi-goals/issues/6).
