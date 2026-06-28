# CompleteGoal fail-forward on judge failure

## Goal
Make `CompleteGoal` stop rejecting verified goals just because the read-only judge subprocess times out. Keep the judge useful when it works, and make failures explicit in the log/result.

## Scope
In: `CompleteGoal` sign-off behavior, judge transport, tests, docs.
Out: broader autonomous loop work, plan-mode UX, model auto-selection.

## Requirements
- R1: If `verify:` fails, the goal is rejected immediately. Done means: existing `verify_failed` behavior remains. VERIFY: unit test for pure sign-off record still passes.
- R2: If `verify:` passes and the judge accepts, mark the goal done as before. Done means: log records normal judge accept. VERIFY: unit test for accepted sign-off still passes.
- R3: If any `verify:` command passes but the judge times out or subprocess/model transport fails, mark the goal done with an explicit inconclusive-judge log. Goals without `verify:` use the same fail-forward rule once evidence exists. VERIFY: a unit test records accepted status and a log line containing `judge inconclusive`.
- R4: Judge transport should parse `pi --mode json` message events instead of raw `-p` terminal output. Done means: code captures final assistant text and provider stop errors distinctly. VERIFY: `npm run typecheck` and tests pass.

## Tasks
- [x] T1 (R3): Add an accepted-with-warning sign-off outcome.
  - verify: `npm test`
  - success: test shows status `[x]` plus `judge inconclusive` in `## Log`
  - likely_fail: timeout still records `reject`
  - sneaky_fail: accepted status lands but log hides judge failure
  - UAT: [test/plan-file.test.ts](/home/wassname/.pi/agent/git/github.com/wassname/pi-plan/test/plan-file.test.ts)
- [x] T2 (R4): Switch judge subprocess to JSON-mode parsing.
  - verify: `npm run typecheck`
  - success: no TypeScript errors, judge code has no ANSI-terminal parsing dependency
  - likely_fail: compile errors around streamed event shape
  - sneaky_fail: model error produces empty output and gets parsed as reject instead of transport failure
  - UAT: [src/index.ts](/home/wassname/.pi/agent/git/github.com/wassname/pi-plan/src/index.ts)
- [x] T3 (docs): Update README sign-off semantics.
  - verify: `rg "inconclusive|timeout|judge accept" README.md src test`
  - success: docs name fail-forward behavior
  - likely_fail: README still says all rejects keep goal open
  - sneaky_fail: docs imply subagent evidence was accepted when it timed out
  - UAT: [README.md](/home/wassname/.pi/agent/git/github.com/wassname/pi-plan/README.md)

## Context
Observed result from downstream use:

```json
{
  "goal": "Make persona validation fail-fast and evidence-correct",
  "outcome": "rejected",
  "durationMs": 120003,
  "verifyCommand": "`uv run python -m compileall -q scripts/validate_persona_axes_openrouter.py`",
  "reasoning": "VERDICT: reject\nmissing: judge timed out after 120s",
  "isError": true
}
```

Interpretation: latest surfaced output proves the internal judge timed out. It does not prove the verify command passed, though earlier logs indicated that pattern.

## Log
- 2026-06-29  current `runJudge` uses raw `pi -p --no-session` output plus ANSI stripping; oracle uses `--mode json` and parses message events, which is likely more reliable.
- 2026-06-29  unset `/goals judge` spawns the judge without `--model`, so Pi resolves its configured default model; do not describe this as the current session model.
- 2026-06-29  timeout/transport failure now maps to `accepted_inconclusive`, preserving partial output in reasoning when available.
- 2026-06-29  fresh-eyes review found loose `/accept/i` verdict parsing and caller-abort fail-forward risk; fixed exact verdict parsing and made caller abort reject.

## TODO
- Consider making `CompleteGoal` expose `verifyExitCode: 0` and `judgeOutcome` separately in details.

## Errors
| Task | Error | Resolution |
|------|-------|------------|
