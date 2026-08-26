# Verification: state-aligned planning mode

## Commands

```text
$ npm test
Test Files  7 passed (7)
Tests  28 passed (28)

$ npm run typecheck
> tsc --noEmit

$ npm run lint
Checked 8 files in 17ms. No fixes applied.

$ git diff --check
```

## Read

[test/goals-flow.test.ts](../../../test/goals-flow.test.ts) covers the visible plan before Refine, an editor prompt before a Refine revision turn, exact multiline Refine notes in `## Interview`, Ready as the only work handoff, Pi editor then Cancel, phase restoration, planning snapshot, writable plan path, allowed `pwd && ls && git log` and `cd . && ls -la`, blocked pipe, and blocked `CompleteGoal`.

[test/prompts.test.ts](../../../test/prompts.test.ts) locks the prompt instruction to inspect discoverable facts or ask one focused question, and forbids placeholder goals.
