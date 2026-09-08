# Initial delegated-worker test failure — Pi/OpenAI

The first implementation check ran `npm run typecheck && npm test` inside the delegated worker's inherited environment (`PI_SUBAGENT_CHILD=1`). Typecheck passed. At that point the suite reported:

```
Test Files  2 failed | 13 passed (15)
     Tests  8 failed | 38 passed (46)
```

Representative actual output from that run (18:39:14):

```
FAIL test/goals-flow.test.ts > /goals flow > preserves drafts, records the interview, and keeps planning read-only
TypeError: Cannot read properties of undefined (reading 'handler')
  at flow.commands.get("goals").handler("first objective", flow.ctx)

FAIL test/rpc-review.test.ts > RPC review flow > opens Refine's editor before it starts the revision turn
Error: Test timed out in 15000ms.
```

Diagnosis: the production `isMainSession()` deliberately excludes subagent children. Consequently the mock host never registered `/goals`, and the real RPC test process inherited the child flag and did not register it either. This was not treated as a passing test and no product guard was removed to conceal it.

Exact corrected test command: `env -u PI_SUBAGENT_CHILD -u PI_GOALS_ROLE npm test`.
That rerun passed all 46 then-existing tests. Subsequent added regressions also passed. The final complete command and unabridged final output are saved in `20260908-review-fixes-validation.txt`; it uses the same two-variable isolation. All role-specific tests still explicitly configure their intended role. No live user session's environment or settings were changed.
