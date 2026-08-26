# Verification: state-aligned planning mode

## Commands

```text
$ npm test
Test Files  6 passed (6)
Tests  25 passed (25)

$ npm run typecheck
> tsc --noEmit

$ npm run lint
Checked 8 files in 17ms. No fixes applied.

$ git diff --check
```

## Read

[test/goals-flow.test.ts](../../../test/goals-flow.test.ts) covers the visible plan before Refine, exact multiline Refine notes in `## Interview`, Ready as the only work handoff, Pi editor then Cancel, phase restoration, planning snapshot, writable plan path, allowed `pwd && ls && git log`, blocked pipe, and blocked `CompleteGoal`.
