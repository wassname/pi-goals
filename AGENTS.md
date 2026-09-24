# pi-goals contributor notes

Keep the design small: one agent, one goals file, the stock scheduler for wakes, pi-subagents for the judge. Do not add a private timer, task store or second agent runtime.

All model-facing text is in `src/prompts.ts`, in conversation order.

## Tests

Run `npm test`, `npm run typecheck` and `npm run lint` before committing.

- `test/harness.ts` fakes Pi, the scheduler commands and the pi-subagents event owner.
- `test/real-parsers.test.ts` checks the fakes against the real scheduler core and pi-subagents parsers. Update it when those dependencies change.
- Test data flow, ownership and lifecycle. Do not assert exact prompt wording.

For a real load check without a model:

```bash
cd "$(mktemp -d)" && echo '{"id":"1","type":"get_commands"}' | pi --mode rpc --no-extensions \
  -e <repo>/src/index.ts -e <repo>/node_modules/pi-subagents/index.ts \
  -e <repo>/node_modules/@jl1990/pi-scheduler/extensions/scheduler/index.ts
```
