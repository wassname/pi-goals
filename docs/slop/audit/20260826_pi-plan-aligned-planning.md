# Verification: state-aligned planning mode

## Commands

```text
$ npm test
Test Files  8 passed (8)
Tests  29 passed (29)

$ npm run typecheck
> tsc --noEmit

$ npm run lint
Checked 8 files in 17ms. No fixes applied.

$ git diff --check
```

## Read

[test/goals-flow.test.ts](../../../test/goals-flow.test.ts) covers the visible plan before Refine, an editor prompt before a Refine revision turn, exact multiline Refine notes in `## Interview`, Ready as the only work handoff, Pi editor then Cancel, phase restoration, planning snapshot, writable plan path, allowed `pwd && ls && git log` and `cd . && ls -la`, blocked pipe, and blocked `CompleteGoal`.

[test/prompts.test.ts](../../../test/prompts.test.ts) locks the prompt instruction to inspect repository facts or search the web only when it can resolve a fact, ask the human to confirm interpretation and approve preference choices, and forbid placeholder goals.

[test/rpc-review.test.ts](../../../test/rpc-review.test.ts) starts the installed Pi RPC executable with [offline-model.ts](../../../test/fixtures/offline-model.ts), selects Refine through Pi's real dialog protocol, receives the editor request before the revision call, then submits notes and observes the revision call. The test uses a local HTTP model, so it spends no API credits.
