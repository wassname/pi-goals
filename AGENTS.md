# pi-goals contributor notes

Keep the design small and close to how models are trained (see README, Design intent): one agent with its normal tools, one goals file, the stock scheduler for wakes, pi-subagents for the judge. Do not add a private timer, task store or second agent runtime. Keep the user's loop statement wording.

All model-facing text is in `src/prompts.ts`, in conversation order.

## Tests

Run `npm test`, `npm run typecheck` and `npm run lint` before committing.

- `test/harness.ts` fakes Pi, the scheduler commands and the pi-subagents event owner.
- `test/real-parsers.test.ts` checks the installed pi-subagents parser and reminder inputs. `npm run test:pi` exercises the real scheduler through Ready and pause.
- Temporary tests belong in ignored `tests/tdd/`, outside the default test run.
- Test data flow, ownership and lifecycle. Do not assert exact prompt wording.

For a real load check without a model:

```bash
cd "$(mktemp -d)" && echo '{"id":"1","type":"get_commands"}' | pi --mode rpc --no-extensions \
  -e <repo>/src/index.ts -e <repo>/node_modules/pi-subagents/index.js \
  -e <repo>/node_modules/@jl1990/pi-scheduler/extensions/scheduler/index.ts
```
