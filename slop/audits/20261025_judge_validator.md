# const_v2 judge validator failure

The failure reproduces in a fresh Node process using the installed global pi-subagents 0.76.0. Restarting the research session alone would not repair the missing dependency. No pi-goals source change was needed.

## Evidence

Session: `/home/code/.pi/agent/sessions/--workspace-2026-constitutional_grafting--/2026-10-08T07-58-09-534Z_01a11a85-0c7d-74e7-95ba-302035ad3e95.jsonl`.

Judge transcript: `/home/code/.pi/agent/sessions/--workspace-2026-constitutional_grafting--/subagent-artifacts/981c4446-f1a5-4b13-8a56-3f05962debe0_pi-goals-judge_0_transcript.jsonl`.

At 2026-10-25T06:29:52.007Z and 06:31:12.166Z, `structured_output` returned:

> Cannot load typebox/compile for structured output validation (direct import failed: Cannot find package 'typebox' imported from /home/code/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/structured-output.js; PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT is not set)

The judge submitted `verdict: accept`, with 19 checks, before each error. This is model output, not recorded goal acceptance and not an independent audit of those checks by this debugging session.

The global extension tree could not resolve `typebox/compile`. Both managed Pi 1.4.0 and the local pi-goals development tree have typebox 1.3.27. Subagents' validator tries its own import, then the package-root environment override; it does not discover the running Pi root as its host SDK loader does. Thus this is a missing optional peer / host-dependency-discovery failure in the global subagents installation, not bad judge JSON. Whether the upgrade caused the missing peer was not established.

## Local repair

Installed exactly the existing Pi dependency version, from the local npm cache:

```sh
cd /home/code/.pi/agent/npm
npm install --ignore-scripts --legacy-peer-deps --save-exact --offline typebox@1.3.27
```

The dry run and actual install each added one package. The first dry run without `--legacy-peer-deps` attempted to resolve unrelated Pi peer versions and failed offline; it was not applied. `package.json` and `package-lock.json` now retain the explicit dependency. No installed extension code was patched.

## Verification and limit

`20261025_judge_validator_verification.log` records replay of both original submissions through the global subagents validator, using the canonical `judgeSchema` imported from pi-goals. Both also pass its structured-output file capture/readback. An invalid verdict and a missing required field are rejected. Tests used no model calls.

No research goals, statuses, schedules or judge receipts were changed. A live CompleteGoal retry was not run; fresh-process validation establishes that the dependency repair works, not that the existing session has completed sign-off. Failed compiler loads are cleared by subagents' `loadCompile`, so a retry is expected to work without restarting, but that live-process path is untested.

## User preference confirmed in this debugging chat

> nah I'd rather waste some tokens than accedently stop?

Keep hourly continuation reminders. Do not add automatic blocked-state pauses or backoff on the basis of this incident. Changing only a task's schedule preserves dynamic goal-file expansion; replacing its `pi-goals-loop:<token>` prompt with ordinary text bypasses expansion.

-- PI/OpenAI
