I only have a file-read tool here, so I’ll start from the repo files I can open and look for the plan-versioning and judge-related changes.Continuing through the judge path and tests.Reading the rest of the judge prompt and the tests that cover these behaviors.Looking for the test files.Trying common test filenames under `src` and `test`.Checking other likely files mentioned in the README.I couldn’t run `git diff` (no shell tool). From the files I could read, these are the concrete defects against the required behaviors:

**1. Uncommitted conflict markers in `README.md`**
The working tree still has `<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes` (and a truncated upstream judge sentence). That is not a reviewable change set.

**2. Judge “checked artifacts” gate is too brittle**
`decideSignOff` only accepts:

```ts
/^#{0,6}\s*(?:\*\*)?checks(?:\*\*)?:\s*\n(?:[-*]\s+.+\n?)+\s*VERDICT:/im
```

The prompt asks for a `checks:` heading plus bullets, then **exactly two lines**:

```
VERDICT: accept | reject
missing: ...
```

Any extra blank line, `Checks` with other wrapping, or a sentence between the last bullet and `VERDICT:` rejects a real accept. That’s stricter than “must show artifact quotes,” and can fail a judge that did the right thing.

**3. Grill-me vs Ready is prompt-only**
`Grill me` sets `skipReadyMenu` for **one** `agent_end`, then the next turn with any goal lines shows Ready again. Nothing checks that the understanding question was asked **and answered**. If the model asks and offers Ready in the same turn, or the human never replies, Ready is still offered. Required: no Ready until that question has completed.

**4. Legacy unversioned plans are dropped with no migration path in code**
Only `<session_id>-vN.md` is selected; `planVersion` restore is the only resume hook. That’s the intended break, but I found no test that old `.pi/plan/*.md` names stay unused and that a new `/goals` always writes a fresh `-vN` without rewriting prior files.

**5. Could not verify the focused tests or `git diff`**
No test file opened (`src/index.test.ts`, `test/*.test.ts`, etc. all missing from this view). I could not confirm coverage for version reservation, visible plan print, grill-me sequencing, or reject-accept-without-checks.

I would **not APPROVE** this set as-is. Fix the README conflicts, tighten grill-me so Ready stays suppressed until after the human answers, and either loosen the checks regex to the documented “quotes present before VERDICT” rule or lock the exact judge format in a test.