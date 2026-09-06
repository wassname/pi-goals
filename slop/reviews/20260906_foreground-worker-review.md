## Review

No issues found.

- Correct: The packaged worker is discoverable in pi-subagents 0.65.1 child-safe fanout. `package.json` exposes `pi.subagents.agents`, which the installed discovery code consumes (`pi-subagents/src/agents/agents.ts:510-538,597-657`), while the child fanout executor uses normal `discoverAgents` (`pi-subagents/src/extension/fanout-child.ts:145-190`).
- Correct: The supervisor gate requires the exact packaged agent, nonempty task, `async:false`, `context:"fork"`, and the configured model with no extra fields (`src/supervisor-runtime.ts:83-108`). The installed executor honors explicit foreground mode (`pi-subagents/src/runs/foreground/subagent-executor.ts:6511-6515,6917-6920`).
- Correct: Foreground completion is tied to the real `tool_result`. `activeWorkerCalls` is removed only when that result arrives, successful completion is recorded, and approval requires a later turn (`src/supervisor-runtime.ts:75-115,132-138`). Same-message worker launch plus approval is independently rejected by inspecting the assistant message.
- Correct: Stale local launch reservations self-heal: errors clear on `tool_result`, and `turn_start` clears any reservation for which no result hook arrived (`src/supervisor-runtime.ts:75-115`). The tests cover duplicate launch, failed-result recovery, and next-turn recovery (`test/supervisor-runtime.test.ts:57-76`).
- Correct: `CompleteGoal` remains blocked while the retained supervisor is pending, while any subagent/process work is active or unknown, or until a matching approval checkpoint exists (`src/index.ts`, `CompleteGoal`). Foreground nested work therefore cannot race sign-off because its containing supervisor run remains pending.
- Correct: `supervisor-runtime.ts` does not perform runtime-agent registration. The main extension exits in child processes through `isSupervisorProcess`, while installed pi-subagents itself is inert when `PI_SUBAGENT_CHILD=1` (`src/index.ts`, `isSupervisorProcess`; installed `pi-subagents/index.ts:3-8`).
- Correct: The former nested async worker ID/pending lifecycle is absent. The remaining `workerRunId`/`workerPending` state belongs only to the retained supervisor lifecycle, matching the documented topology.

Residual risks:
- `test/package-agent.test.ts` verifies packaging statically rather than launching the packaged worker through the real child-safe fanout runtime. The installed 0.65.1 source supports the configuration, but retaining an RPC integration check is advisable.
- The focused approval tests mock Pi’s `tool_call`/`tool_result` ordering. A real RPC test remains the strongest guard against upstream lifecycle-event changes.
- Tests were inspected but not executed in this review environment; the supervisor should run `npm test`, `npm run typecheck`, and `npm run lint`.

- Merge verdict: **OK with residual test-environment risks.**

-- PI[reviewer/gpt-5.6-sol]
