# pi-goals contributor notes

Keep the design small and close to how models are trained (see README, Design intent): one agent with its normal tools, one goal on one page, the stock scheduler for wakes, pi-subagents for the judge (at a stop and at completion). Do not add a private timer, task store or second agent runtime. The reminder says the goal and to keep going until the user stops it; keep that wording short. A page may carry its own `## Loop statement`, which is then sent in its place, but planning never asks for one.

The page above `## Resume here` is the user's. No code path may let the agent change it while working, and nothing the agent writes below it is re-sent beyond the note's first lines and the newest evidence. The history of earlier designs, with the commits to read, is in `docs/architecture-history.md`.

All model-facing text is in `src/prompts.ts`, in conversation order.

## Tests

Run `npm test`, `npm run typecheck` and `npm run lint` before committing.

- `test/harness.ts` fakes Pi, the scheduler commands and the pi-subagents event owner.
- `test/real-parsers.test.ts` checks the installed pi-subagents parser and reminder inputs.
- Temporary tests belong in ignored `tests/tdd/`, outside the default test run.
- Test data flow, ownership and lifecycle. Do not assert exact prompt wording.

<!-- PI/OpenAI: moved integration test commands from the README. -->
Run the scheduler integration tests with isolated state and no model calls:

- `PI_TEST_BIN=/path/to/node-pi npm run test:pi` checks Ready, reminder creation, and removal on pause.
- `PI_COMPILED_BIN=/path/to/compiled-pi npm run test:compiled` checks the same flow on compiled Pi. Scheduler 0.6.0 fails to load on compiled Linux Pi 1.4.0 and 1.5.2.
- Add `PI_TEST_NO_SCHEDULER=1` to the compiled Pi command to check that work starts and the missing scheduler is recorded.

For a real load check without a model:

```bash
cd "$(mktemp -d)" && echo '{"id":"1","type":"get_commands"}' | pi --mode rpc --no-extensions \
  -e <repo>/src/index.ts -e <repo>/node_modules/pi-subagents/index.js \
  -e <repo>/node_modules/@jl1990/pi-scheduler/extensions/scheduler/index.ts
```
