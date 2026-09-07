# Visible supervisor handover

## Objective

Replace pi-goals' nested pi-subagents worker with two visible Pi sessions:

1. The main session plans with the user, then becomes the implementation worker.
2. On Ready, pi-goals explicitly forks the planning session into a Herdr pane.
3. Only the fork is compacted. It becomes the stronger read-only supervisor.
4. pi-supervise and pi-intercom connect the supervisor to the worker.
5. The worker starts only after the real pi-supervise `pair`/`paired` acknowledgment.
6. The supervisor retains the plan, compact planning context, and concise worker views. It can steer the worker and approve a completed goal.
7. The supervisor compacts near 100k tokens.

Keep this minimal. Reuse pi-supervise's intercom protocol instead of building a second orchestration layer.

## User preferences

- The primary session must do the implementation. Other agents may test or review it, but must not own core development.
- Avoid relaying implementation decisions through multiple agents.
- Herdr should open the supervisor automatically and let the user switch to it.
- Persist configurable models for three stages:
  - planning: strongest model, for example Fable 5.1 or Astra;
  - supervision: for example Sol or Opus;
  - implementation: for example Terra, Sonnet, Kimi K3, DeepSeek Pro, or GLM 5.3.
- Validate model IDs through Pi. Do not hard-code a model list.
- Switch the main session to the planning model when planning starts and to the worker model only after pairing succeeds. Launch the fork with the supervisor model.

## Repository state

pi-goals branch: `experiment/subagent-supervisor`

Committed work:

- `d56fc55` — replace nested workers with a visible supervisor session
- `e299e84` — run supervisor bootstrap through the pane shell
- `c5782ee` — initial pairing handshake, evidence checks, Herdr parsing, and worker intercom ID
- `7eb8b1f` — treat stale pane close as successful cleanup
- `1dc6146` — allow `PI_GOALS_SUPERVISE_EXTENSION` for local development

pi-supervise committed dependency:

- `4e3cd1c` — acknowledged programmatic supervisor pairing API; package version 0.0.4

Uncommitted pi-goals files:

- `src/intercom.ts`
- `src/supervise.ts`
- `test/intercom.test.ts` (new)

Uncommitted pi-supervise file:

- `src/index.ts`

Inspect these diffs before editing. They are a partial design-B refactor and have not passed the real workflow.

## Why design B was selected

Primary-source review found that pi-supervise already sends `pair` and receives the worker's `paired` acknowledgment. The custom `pi-goals/visible-supervisor/v1` intercom namespace duplicated that acknowledgment and introduced another registration and connection race.

Selected design:

- pi-supervise exposes the worker's actual broker ID through a local extension API;
- pi-supervise emits or resolves a worker-local event only after the real `paired` acknowledgment;
- pi-goals passes that broker ID to the supervisor;
- pi-goals waits for that worker-local paired acknowledgment before setting `phase: working` or sending the worker kickoff;
- delete `src/intercom.ts` and custom supervisor-ready messages if the partial diff has not already completed that deletion;
- support either extension load order by using pi-intercom/pi-supervise registry-ready events idempotently.

Do not use pi-intercom `project-agent.ts` as another lifecycle. It opens a generic Pi pane and polls broker presence but does not supply the required fork, extensions, model, or pairing semantics.

## Observed tests and failures

Unit validation before the unfinished design-B refactor:

- pi-goals: 26 tests passed, typecheck passed, lint passed, package dry-run passed, RPC test passed.
- pi-supervise: 97 tests passed and package dry-run passed.

Real Herdr observations:

1. The initial smoke loaded pi-supervise directly from source and did not exercise pi-goals' actual Ready command.
2. A later actual `/goals` → Ready run failed before pane creation because pi-goals emitted `intercom:extension-register` before pi-intercom installed its listener.
3. A local uncommitted registry-ready re-registration fix moved the real path farther: Ready created supervisor pane `w8:p1F` through `supervisorCommand`.
4. That run then timed out waiting for the duplicate custom `supervisor-ready` message. This led to design B.
5. The supervisor exited before its transcript was preserved. Do not infer that pi-supervise pairing succeeded.

The real end-to-end workflow has not passed.

## Next work

1. Read the uncommitted diffs in both repositories and finish or simplify design B.
2. Add focused tests:
   - pi-supervise local API works whether pi-goals loads before or after pi-supervise;
   - no `phase: working` or kickoff before actual `paired`;
   - duplicate `paired` is idempotent.
3. Run the actual pi-goals path, not a substitute command:
   - start worker with pi-goals and pi-intercom;
   - enter `/goals`, draft a plan, and select Ready;
   - use `PI_GOALS_SUPERVISE_EXTENSION=/home/code/.pi/agent/git/github.com/wassname/pi-supervise/src/index.ts` until 0.0.4 is published;
   - positively observe fork-only compaction, actual pairing acknowledgment, then worker kickoff;
   - preserve supervisor stdout/stderr and session JSONL before cleanup on every failure;
   - observe supervisor monitoring or steering;
   - complete real evidence at a clean commit, approve it, call CompleteGoal, and close the pane.
4. Commit the lifecycle separately once the real path passes.
5. Add the three persisted model settings in a separate commit.
6. Run tests, typecheck, lint, package dry-runs, real RPC tests, and a fresh read-only review.

## Known packaging constraint

`src/herdr.ts` defaults to `npm:@wassname2/pi-supervise@0.0.4`. Version 0.0.4 is not publicly published. Do not publish without explicit editorial approval. Local testing must use `PI_GOALS_SUPERVISE_EXTENSION`.

## Important lifecycle bug discovered in this session

`/goals clear` cleared extension state but left the current model request under the previously injected coordinator system instruction. `/reload` did not remove it. A fresh ordinary Pi session is required for direct implementation. The redesign should avoid leaving a session unable to resume ordinary work after clear.

-- PI[gpt-5.6-sol]
