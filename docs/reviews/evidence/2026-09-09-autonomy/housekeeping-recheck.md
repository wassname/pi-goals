## Review

Read-only recheck limited to the parent’s fixes for the previously reported P1/P2.

- **Fixed — P1 resolved:** `src/prompts.ts:199–201` now requires retaining every goal line, completion status, and evidence references above `## Log`; only verbose settled detail moves into the Appendix. This matches the unchanged identity/status filtering in `src/index.ts:220–228`. The pruning instruction and Git-history assumption are gone.
  - `test/prompts.test.ts:32–38` guards the corrected instructions.
  - `test/goals-flow.test.ts:183–201` moves supporting detail below the fold, exercises the reload hook, and confirms both accept/inconclusive records, the `2/2` count, and inconclusive disclosure remain intact without emitting new work.

- **Fixed — P2 resolved:** `src/prompts.ts:291–294` now directs the judge to review the unique exact subject and reject missing or ambiguous identity without substituting another goal. The overview in `src/index.ts:21–30` and descriptions in `test/tick-goal.test.ts:16–25` agree with that contract. `test/prompts.test.ts:40–44` guards against restoring fuzzy-match wording.

- **Correct:** These are bounded prompt/documentation and regression changes. They resolve the conflicts without changing sign-off invalidation semantics, inferring historical approval, or introducing a Git gate.

**No issues found.**

### Validation

Inspected the parent’s saved logs:

- `housekeeping-red.log`: the two new prompt assertions failed against the former wording.
- `housekeeping-green.log`: **3 test files / 43 tests passed**.

No commands were run or files edited by this reviewer.

### Merge verdict: OK with notes

Both previous findings are resolved; the narrow fixes are approved. This supersedes the previous source-review block.

Full `npm test` and real isolated Herdr acceptance remain environment-blocked/pending. The targeted tests establish prompt and lifecycle behavior, not real-model judgment or completed two-goal acceptance. Broader parent validation was not attested by this recheck.