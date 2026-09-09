# Autonomous supervision: implementation checked, live acceptance pending

Base: `cecb1e9`, branch `feature/simple-visible-supervision`. Follow-up changes are uncommitted.
Scope: [approved plan](../slop/plans/20260909_autonomous-supervision-acceptance.md).

## Implemented

- Outcome-focused supervisor instructions: investigate blockers, change ineffective steering, inspect actual results, and keep authorized work moving. VCC and existing lifecycle protections remain.
- Ordinary prose, empty responses and genuine questions do not discard later worker views or direction. Monitoring does not authorize restarting human-paused work. No immediate idle retry loop.
- Manual checkmarks are claims; CompleteGoal records conclusive or inconclusive sign-off separately. Exact goal identity, cancellation and fresh-judge behavior remain. Legacy completion is labelled without inventing approval or restarting old work.
- Dirty Git state is context, not an acceptance gate. Cited ignored output files are valid inspection targets; no forced cleanup or commit.
- Material planning questions replace the quota; Discuss remains ordinary chat. AGENTS.md includes the other branch's relevant user preferences and real-Herdr testing procedure.

## Parent validation

- [Permitted Vitest subset](evidence/2026-09-09-autonomy/parent-permitted-vitest.log): `Tests  94 passed (94)`, across 13 files. Explicitly excludes `test/rpc-supervisor.test.ts`; this is not a passing full suite.
- [Supervisor regressions](evidence/2026-09-09-autonomy/parent-supervisor.log): `ℹ tests 176`, `ℹ pass 176`, `ℹ fail 0`.
- [Typecheck](evidence/2026-09-09-autonomy/parent-typecheck.log), [lint](evidence/2026-09-09-autonomy/parent-lint.log), and [build](evidence/2026-09-09-autonomy/parent-build.log) exited successfully. `git diff --check` passed on source changes.
- Review found conflicting advice to prune completed goal lines and stale fuzzy-match descriptions. Parent corrected the instructions and added regressions. [Red](evidence/2026-09-09-autonomy/housekeeping-red.log) shows the two prompt failures; [green](evidence/2026-09-09-autonomy/housekeeping-green.log) records 43 passing tests, including preserved conclusive/inconclusive records after moving detail into the appendix.
- [Read-only recheck](evidence/2026-09-09-autonomy/housekeeping-recheck.md): “Both previous findings are resolved; the narrow fixes are approved.”

## Still required

Full `npm test` did not pass: [broker diagnostics](evidence/2026-09-09-autonomy/broker-diagnostic.log) show Unix-socket `listen EPERM` in the tsx launcher. Parent Herdr control independently returned `PermissionDenied: Operation not permitted`. No TMPDIR/IPC workaround was authorized or used to bypass the restriction.

The fresh two-goal Herdr trial has not run. It must show both actual artifacts and verification output, both CompleteGoal results, useful visible supervision, same-pair continuity, explicit-pause/reload behavior, ignored output files and preserved unrelated dirty work. Record every operator intervention and separate worker/supervisor usage. Do not treat deterministic tests as evidence of live judgment or savings.

No role preferences, active installation, existing panes, or unrelated root-worktree files were changed in this follow-up. No commit, push, merge or release yet.

Recorded by Pi (OpenAI) from observed command output and the independent source review.
