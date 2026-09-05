# Main-agent supervisor with a retained pi-subagents worker

The main Pi session keeps the high-level research context and uses the stronger model. A cheaper `goal-worker` child implements the plan. pi-subagents owns the child fork, continuation, background completion, and Fleet visibility. pi-vcc compacts long context.

## User-visible result

After Ready, the main session supervises a retained worker: it reviews every 60 minutes, responds when the worker finishes and no other work remains, and signs off goals from inspected evidence.

## User voice

- > “Another take on my pi-intercom-supervisor but using pi-subagents not a seperate user started terminal. I want to keep it simple by using pi-vcc pi-subagents where possibe”
- > “fork and compact because I hope to use a smarter model for the supervisor with better research taste.”
- > “only check in sees a summary, and ideally compacts at 100k”

## Goals

1. [x] goal: Keep the stronger main session as supervisor and retain a cheaper child worker
   - subtle failure mode: each instruction starts a fresh child that forgets earlier work.
   - discriminator: a real Ready flow forks `goal-worker`; later guidance resumes its latest run ID and Fleet shows the child.
   - tasks:
     1. [x] register `goal-worker` through the pi-subagents runtime API with a separate `/goals model` setting
     2. [x] fork on Ready and store each replacement run ID returned by resume
     3. [x] keep implementation and plan edits in the child; keep evidence review and `CompleteGoal` in the main session
   - evidence:
     - `slop/audits/20260905_goal-worker-runtime-proof.json`: a real Ready flow created a child fork and wrote `"reason": "below-compactable-size"`.
     - `slop/audits/20260905_subagent-supervisor-validation.txt`: `Tests  37 passed (37)`, including spawn, continuation, steering, and a completion-before-RPC-reply race.

2. [x] goal: Compact context without adding a custom transport
   - subtle failure mode: the worker inherits the full expensive transcript, or a different compactor silently handles it.
   - discriminator: the child runtime records either pi-vcc compaction or that the exact fork is below Pi's compaction minimum; the main session requests pi-vcc near 100k tokens.
   - tasks:
     1. [x] load pi-vcc in the child and compact the initial fork before its first turn
     2. [x] fail if a different child compactor reports success
     3. [x] compact the main supervisor near 100k and warn if pi-vcc did not handle it
   - evidence:
     - `slop/audits/20260905_goal-worker-runtime-proof.json`: the real child runtime recorded its explicit below-minimum outcome rather than silently claiming compaction.
     - `test/worker-runtime.test.ts` covers pi-vcc success, below-minimum context, retained resume, and wrong-compactor failure; `test/goals-flow.test.ts` covers the 100k main-session request.

3. [x] goal: Check hourly and after worker completion without a self-review loop
   - subtle failure mode: each supervisor settle schedules a new immediate review, or a child completion is mistaken for all work being idle.
   - discriminator: one timer keeps its original hourly cadence; pi-subagents completion wakes the main session once; `CheckGoalWork` reports exact subagent and process state before a restart decision.
   - tasks:
     1. [x] keep one 60-minute timer active until goals close, auto is disabled, or the plan is cleared
     2. [x] use native pi-subagents completion delivery instead of a second idle wake
     3. [x] query public pi-subagents and pi-processes status; treat omitted or missing status as unknown
   - evidence:
     - `test/goals-flow.test.ts` keeps the first timer deadline across an intervening settle and checks idle status after native completion.
     - `test/worker.test.ts` distinguishes active, nested-active, idle, omitted/unknown, and missing pi-processes status.
     - `slop/audits/20260905_subagent-supervisor-validation.txt`: typecheck, lint, whitespace check, and package dry-run passed.

## UAT / verification

- Run `npm test`, `npm run typecheck`, `npm run lint`, `git diff --check`, and `npm pack --dry-run`; save exact output.
- Real runtime: load pi-goals with pi-subagents and pi-vcc, approve a plan, observe a real `goal-worker` fork and the fork-preparation record, then stop the test run.
- Inspect the final diff for duplicate wake paths, silent status fallbacks, and instructions that tell the main supervisor to implement worker tasks.

## Appendix (context, not approved)

A normal Pi TUI cannot switch into the child's full interactive session. Fleet can inspect and steer it. This design keeps the visitable persistent context in the main session and uses retained child continuation for implementation.

pi-subagents always sends an async completion to the parent. Therefore worker completion is the idle-review wake. Adding another `agent_settled` wake would create a completion → supervisor → settle loop.

`CheckGoalWork` sees parent-process pi-processes state. A process started inside the worker remains covered indirectly because the top-level worker run stays active while its child work runs.

Sources read: pi-subagents `README.md`, `docs/extension-api.md`, `docs/observability.md`, `docs/workflows.md`, execution controls; pi-processes request/list client; pi-vcc package behavior; `pi-supervise/RESEARCH_JOURNAL.md`.

-- Pi/Codex
