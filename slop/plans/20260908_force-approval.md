# Dirty-worktree approval override — Pi/OpenAI

Baseline: cb4790a. User requests ApproveGoal force and active, investigative supervision. Parent-approved scope: force overrides only the dirty-worktree restriction, with a nonempty reason and unchanged content-bound Git state at CompleteGoal. Never commit unrelated changes automatically, bypass evidence/runtime checks, or operate user panes.

- [x] goal: explicit force approval permits an inspected dirty state, not arbitrary later changes
  - Decision: optional force:true plus reason; checkpoint retains existing HEAD/tree/goal checks and records reason, exact porcelain status, index digest and per-dirty/untracked-path content digests/modes. Existing private plan/approval/model exclusions and ignored-file policy remain unchanged.
  - Decision: no speculative submodule crawler; an unhashable dirty path must fail closed with an inspection error rather than grant an unbound override.
  - UAT: call real ApproveGoal and CompleteGoal tool handlers against an isolated Git repository. Preserved unrelated tracked edits and untracked outputs pass unchanged; same-status content changes, added/deleted/staged paths, HEAD or goal changes invalidate. Default dirty rejection and force-without-reason rejection remain. Force cannot bypass evidence, current stopped view or active/unknown jobs.
- [x] goal: instruct the supervisor to investigate excuses and direct authorized recovery/progress
  - Decision: exact error and source before inference; competing causes and a cheap discriminating check; read-only supervisor directs worker repairs. Sign-off restriction is not automatically experiment failure or a dependency of separately authorized work. No new authority, spending or mutation tool.
  - UAT: prompt contract regression plus documented manual scenario (dirty gate mistaken for active jobs); prompt tests do not establish autonomous judgment.

## Validation/provenance

Read AGENTS.md and installed Pi extension custom-tool/schema documentation. Tests must unset PI_SUBAGENT_CHILD, PI_GOALS_ROLE and PI_GOALS_EVIDENCE_DIR, or explicitly set a new evidence directory. Two pre-existing dirty review-fixes-native logs must remain untouched. Save complete validation output; commit scoped changes locally only. Independent review is parent-owned and still required.

## Result

Implemented and checked: [85 passing tests + typecheck/lint/build](../reviews/20260908-force-validation.txt). Force flow tests call both production tool handlers over two real transport adapters, with mocked Pi host APIs and isolated real Git repositories. They do not touch Herdr panes. Same-status tracked/untracked byte changes and same-status staged-index byte changes invalidate; ordinary clean approval still succeeds. Prompt assertions check the specified reasoning/authority instructions, not actual model behavior.

Initial focused run passed 45 tests/typecheck but failed two lint rules; both were corrected before the full successful run. [Initial output](../reviews/20260908-force-initial-validation.txt) is retained, not counted as a pass. Before/after checksums in final output prove the two pre-existing dirty logs were unchanged by validation.

Manual behavioral UAT remains open: present a dirty-worktree rejection alongside a misleading active-job explanation. Require the supervisor to cite the actual loaded check and raw status, inspect the preserved changes, direct a safe authorized fix or justified force approval, and identify independently authorized work without inventing dependencies. No useful-judgment claim from prompt tests.

No push, no nested review loop, no /goals supervise or noplan work. Parent's w8:p4T functional pane at pinned cb4790a was not touched. Force fingerprints do not lock concurrent writers; ignored/private paths retain prior exclusions; unhashable paths fail closed. Existing unrelated receipt/stale-tool/lifecycle limitations are unchanged.
