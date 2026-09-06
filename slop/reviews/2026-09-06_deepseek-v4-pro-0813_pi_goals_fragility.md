---
requested_model: deepseek/deepseek-v4-pro-0813
mode: code review
input: src/worker.ts, src/supervisor-runtime.ts
trace: omitted from git (11 MB raw provider transcript)
generated: 2026-09-06T04:44:52.809370+00:00
---

# MoA fragility review


Decision: reject the current fix and replace duplicate async lifecycle state with one synchronous worker tool.

Strongest objection: if a truly synchronous worker RPC is unavailable, this simplification blocks the intended parallel supervision model.

Next check: read the goal-worker tool implementation and the three failing test transcripts before deleting code.

Smallest recommended architecture:

The supervisor extension must not store worker lifecycle state. Lifecycle is owned by the subagent runtime. Move ownership into one tool boundary.

1. Delete NESTED_STATE persistence, event listeners, pending reconciliation, CheckWorkerState, and the replacement guard from supervisor-runtime.ts.
2. Add a single supervisor tool:
   - RunGoalWorker: starts and awaits a goal-worker synchronously, using the aggregate output as a tool result.
   - Keep one in-memory boolean `workerRunning`, guarded at tool execute start, not relying on event ordering.
3. If that synchronous tool cannot be supported:
   - StartGoalWorker returns a run ID as ordinary tool output.
   - WaitGoalWorker(runId) blocks on terminal status check.
   - ApproveGoal always calls bg_wait on the ID from StartGoalWorker or WaitGoalWorker; otherwise approval fails.

Because existing failure 2 came from the runtime blocking on a mismatched ID, the important property is:
- an ID not produced by StartGoalWorker/WaitGoalWorker may not be used for bg_wait;
- a failed wait must clear any in-process guard immediately;
- an await cover failure must be treated as a terminal error, not as `pending`.

Exact deletions/changes:

In `src/supervisor-runtime.ts`:
- Remove `NESTED_STATE`, `NestedState`, `nested`, `persist`, `targetRun`, `completeNested`, all `subagent:async-*`, process-terminal listeners, and `retainedRunState` reconciliation.
- Remove `pi.events.on("tool_call")` blocks. Replace with allow/deny only: deny edit/write, allow read-only bash, allow RunGoalWorker, allow bg_wait, allow ApproveGoal, deny subagent action tools.
- Replace CheckWorkerState with nothing. State inspection is only through normal async progress updates.
- ApproveGoal asserts no active await cover currently exists from RunGoalWorker or WaitGoalWorker, processWorkState is idle, worktree is clean, and evidence inspection claims are backed by the actual tool result from RunGoalWorker.

In `src/worker.ts`:
- Drop `retainedRunState` and any pending-closure logic.
- Keep `asyncSnapshot` only for processWorkState, if needed.

Why this removes fragility:
- Duplicate state is gone.
- Lifecycle is only stored in the runtime’s tool execution stack.
- Revival cannot resurrect a wrong worker ID unless a new tool starts it.
- Race between event handler and spawn disappears because Start or Wait returns a result synchronously to the model.

Why this may be worse:
- Synchronous wait loses the supervisor's ability to issue corrections inline during progress.
- Parallel instrumented runs cannot be sustained within one tool without exposing `bg_wait` to the model.
- If the model calls WaitGoalWorker with an incorrect ID, it will now fail directly, but the failure must not be caught and retried with a cached ID.

Acceptance test to catch all observed failures:
- Send the supervisor script: `StartGoalWorker` → `WaitGoalWorker(id)` → `RunGoalWorker(correction)` → `ApproveGoal`, where a midway kill drops the terminal event and forces session revival, and then assert the code path stores no `NESTED_STATE`, does not even mention it in the extension memory, and either the worker returns a tool result or the revived session remains in the same `WaitGoalWorker` tool with no retry on an ID not yielded by that tool.

## Completion

- outcome: `completed_after_follow_up`
- trace: omitted from git (11 MB raw provider transcript); this file preserves the complete review answer
