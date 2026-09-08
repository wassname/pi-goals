# pi-goals

Plan in one Pi session, then do the work there while a stronger visible Pi session supervises it.

## How it works

1. `/goals <objective>` creates `.pi/plan/<session_id>-vN.md` and enters read-only plan mode.
2. Pi asks only material questions, writes the plan, and shows **Ready / Refine / Edit / Cancel**.
3. **Ready** opens a second Herdr pane. The new Pi session explicitly forks the planning session and compacts that fork.
4. The original session becomes the implementation worker. It keeps the full conversation and normal tools.
5. The fork becomes a read-only supervisor. Worker views and supervisor instructions travel over pi-intercom's extension channel, scoped to this plan pairing.
6. Ready waits for the supervisor's Intercom readiness message; the worker does not begin before the fork has compacted and started.
7. The supervisor compacts again when its context reaches 100k tokens.
8. The supervisor records a private approval only after it sees a stopped worker, no active work, a clean commit, evidence, and saved verification output. `CompleteGoal` checks that approval against the exact plan block and Git tree before it ticks `[x]`.

The two Pi sessions are visible. You can switch to the supervisor pane and talk to it directly. Supervisor instructions are shown in full, including in collapsed tool rows; ordinary messages and emitted thinking use Pi's display settings. The supervisor is prompted to give brief progress assessments and use judgment about when to intervene.

On resume, monitoring and read-only tools are restored. Views include the latest human direction, source-session path, worker model, and new messages since the last acknowledged view. They report Pi idleness and tracked process/subagent activity separately. Unavailable trackers stay unknown; unregistered detached jobs are not tracked. Approval is blocked while tracked work is active or unknown. Intercom disconnects are reported; unsent current views and unacknowledged instructions are retained in Pi session history for reconnect. A receipt confirms adapter handling only—not durable queue persistence, model receipt, or execution. Pi's void message API can fail asynchronously after that acknowledgement; crashes can also cause duplicate handoffs. End-to-end exactly-once or durable delivery is not guaranteed. Reviews stop after all goals are completed or cancelled, and both panes remain available. These mechanics are tested; useful judgment and savings from a cheaper worker still require a representative two-model run. -- Pi/OpenAI

## Install

This branch requires Herdr 0.7.5 or newer and one Pi package. It reuses installed pi-intercom or loads its pi-intercom dependency when none is registered:

```bash
pi install npm:@wassname2/pi-goals
```

For a local checkout:

```bash
pi -e .
```

Run Pi from the Git repository that the plan will change. **Ready** fails if the current directory is not inside a Git repository; this prevents approval from checking the wrong repository.

## Commands

```text
/goals <objective>          create a new plan
/goals model <model>        select the visible supervisor model
/goals model                use the remembered supervisor model
/goals clear                close the supervisor pane and disconnect the plan
```

`/goals clear` keeps the plan file. Starting another plan also keeps older versions.

If a required model or supervisor is unavailable, the widget says **goals paused** and implementation/sign-off tools are gated. Human input, read-only diagnosis, `/model`, and recovery commands remain available:

- `/goals reconnect` retries the remembered role model and existing supervisor binding. Reconnect waits five seconds and never replaces a slow or missing pane automatically. A returning peer clears the connection pause automatically.
- `/goals restart` explicitly closes only the tracked supervisor pane and starts a replacement for a working plan, preserving its file/version but invalidating old approvals. During planning it clears the failed pane so Ready can launch again.
- In the supervisor pane, use `/model` then `/goals reconnect` to recover an unavailable supervisor model.

A new supervisor may still need up to five minutes for initial compaction. Recovery does not terminate background jobs. Planning/diagnostic command checks are guardrails, not an OS sandbox; loaded extensions and repository Git configuration must be trusted.

Model choices are remembered per project and role in `.pi/pi-goals/models/`. Use `/model` in planning, worker, or supervisor sessions to change that role's choice. Ready restores the worker choice after the planning fork is ready. An unavailable saved model stops the transition instead of substituting another. `/goals model <model>` explicitly overrides the supervisor choice for launch. -- Pi/OpenAI

## Plan format

A goal is a checkbox line whose text starts with `goal:`:

```md
1. [ ] goal: Produce the report
   - subtle failure mode: the report exists but uses stale data
   - discriminator: the report cites the current input and the saved check confirms it
   - verify: `just verify`
   - evidence: (empty until sign-off)
```

The worker saves verification output in a nonempty repository file, adds that path to evidence, and commits it. The supervisor calls `ApproveGoal` with the inspected path; the worker then calls `CompleteGoal` with the exact goal text.

## Development

```bash
npm test
npm run typecheck
npm run lint
```

`test/intercom-broker.test.ts` checks readiness and exact message delivery through an isolated real Intercom broker. `test/rpc-review.test.ts` runs the planning review flow through Pi's real RPC protocol with a local deterministic model. The Herdr launcher and visible supervisor bootstrap have focused tests; use a real Herdr session for the final two-pane check.

-- PI[gpt-5.6-sol]
